import { Drive9SDKError, StatusError } from "./drive9-sdk/error";
import { ObsidianDrive9SDKClient } from "./drive9-sdk/obsidian-client";
import type { StatResult, FileInfo, ProgressFn, SearchResult } from "./types";

/** Files >= this size use SDK multipart upload (matches server threshold). */
const MULTIPART_THRESHOLD = 50_000; // 50 KB

/**
 * Drive9Client preserves the plugin-facing API while delegating the wire
 * protocol to the Drive9 TypeScript SDK adapter.
 */
export class Drive9Client {
  private sdk: ObsidianDrive9SDKClient;

  constructor(
    private serverUrl: string,
    private apiKey: string,
    private actorId = "",
  ) {
    this.sdk = new ObsidianDrive9SDKClient(serverUrl, apiKey);
    this.sdk.setActor(actorId);
  }

  updateConfig(serverUrl: string, apiKey: string): void {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.sdk.updateConfig(serverUrl, apiKey);
    this.sdk.setActor(this.actorId);
  }

  setActorId(actorId: string): void {
    this.actorId = actorId;
    this.sdk.setActor(actorId);
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getAPIKey(): string {
    return this.apiKey;
  }

  getActorId(): string {
    return this.actorId;
  }

  /** Test connectivity and auth. Throws on failure. */
  async ping(): Promise<void> {
    await this.list("/");
  }

  /** POST /v1/provision — create a new tenant. No auth required. */
  async provision(): Promise<{ api_key: string; status: string }> {
    return this.wrap(() => this.sdk.provision());
  }

  /** GET /v1/status — check tenant provisioning status. Requires auth. */
  async getStatus(): Promise<{ status: string }> {
    const status = await this.wrap(() => this.sdk.status());
    return { status: String(status.status ?? "") };
  }

  /** HEAD — get file/dir metadata including revision. */
  async stat(path: string): Promise<StatResult> {
    const st = await this.wrap(() => this.sdk.stat(path));
    return {
      size: st.size,
      isDir: st.isDir,
      revision: st.revision,
      mtime: st.mtime?.getTime() ?? 0,
    };
  }

  /** GET — read file content. */
  async read(path: string): Promise<ArrayBuffer> {
    const data = await this.wrap(() => this.sdk.read(path));
    return toArrayBuffer(data);
  }

  /**
   * Write file content with optional CAS revision check.
   *
   * Returns { revision: number } on full success, or
   * { revision: null, writeSucceeded: true } if write succeeded but
   * post-write stat failed (caller must not treat this as a write failure).
   */
  async write(
    path: string,
    data: ArrayBuffer,
    expectedRevision?: number | null,
    onProgress?: ProgressFn,
  ): Promise<{ revision: number | null; writeSucceeded: boolean }> {
    const bytes = new Uint8Array(data);
    const expected = expectedRevision ?? -1;

    await this.wrap(async () => {
      if (bytes.byteLength >= MULTIPART_THRESHOLD) {
        await this.sdk.writeStreamWithSummary(path, bytes, bytes.byteLength, {
          expectedRevision: expected,
          onProgress,
        });
      } else {
        await this.sdk.writeWithRevision(path, bytes, { expectedRevision: expected });
      }
    });

    try {
      const st = await this.stat(path);
      return { revision: st.revision, writeSucceeded: true };
    } catch {
      return { revision: null, writeSucceeded: true };
    }
  }

  /** DELETE — remove a file. */
  async delete(path: string): Promise<void> {
    await this.wrap(() => this.sdk.delete(path));
  }

  /** POST ?rename — rename/move a file. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.wrap(() => this.sdk.rename(oldPath, newPath));
  }

  /** POST ?mkdir — create a directory. */
  async mkdir(path: string): Promise<void> {
    await this.wrap(() => this.sdk.mkdir(path));
  }

  /** GET ?list=1 — list directory contents. */
  async list(path: string): Promise<FileInfo[]> {
    const entries = await this.wrap(() => this.sdk.list(path));
    return entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      isDir: entry.isDir,
      mtime: entry.mtime?.getTime() ?? 0,
    }));
  }

  /** GET ?grep= — hybrid search (FTS + vector + keyword fallback). */
  async grep(query: string, limit = 20): Promise<SearchResult[]> {
    return this.wrap(() => this.sdk.grep(query, "/", limit));
  }

  /**
   * Recursively list all files under a path.
   * Returns flat list of relative paths (no leading slash).
   *
   * Root list errors are propagated (auth/network failures must not
   * be silently treated as "remote empty"). Only subdirectory list
   * errors are swallowed.
   */
  async listRecursive(basePath: string): Promise<FileInfo[]> {
    const result = await this.listRecursiveDetailed(basePath);
    return result.entries;
  }

  /**
   * Recursively list all files under a path and report whether the tree scan
   * completed without any subdirectory list failures.
   */
  async listRecursiveDetailed(basePath: string): Promise<{ entries: FileInfo[]; complete: boolean }> {
    const rootEntries = await this.list(basePath);

    const all: FileInfo[] = [];
    let complete = true;
    const queue: Array<{ dir: string; entries: FileInfo[] }> = [
      { dir: basePath, entries: rootEntries },
    ];

    while (queue.length > 0) {
      const { dir, entries } = queue.pop()!;
      for (const entry of entries) {
        const fullPath = dir === "/" || dir === ""
          ? entry.name
          : `${dir}/${entry.name}`;
        if (entry.isDir) {
          try {
            const subEntries = await this.list(fullPath);
            queue.push({ dir: fullPath, entries: subEntries });
          } catch {
            complete = false;
          }
        } else {
          all.push({ ...entry, name: fullPath });
        }
      }
    }

    return { entries: all, complete };
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw normalizeDrive9Error(error);
    }
  }
}

export class Drive9Error extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(sanitizeError(message));
    this.name = "Drive9Error";
  }
}

/** Strip auth material (Bearer tokens, API keys) from error strings. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/Authorization:\s*\S+/gi, "Authorization: ***");
}

function normalizeDrive9Error(error: unknown): Drive9Error {
  if (error instanceof Drive9Error) return error;
  if (error instanceof StatusError) {
    return new Drive9Error(error.message, error.statusCode);
  }
  if (error instanceof Drive9SDKError) {
    return new Drive9Error(error.message, 0);
  }
  if (error instanceof Error) {
    return new Drive9Error(error.message, 0);
  }
  return new Drive9Error(String(error), 0);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}
