// Obsidian-compatible subset of mem9-ai/drive9 clients/drive9-js@0.1.3.

import { requestUrl, RequestUrlParam } from "obsidian";
import { statusError } from "./error";
import type {
  FileInfo,
  SearchResult,
  StatResult,
  TenantStatus,
  UploadSummary,
  WriteOptions,
} from "./models";
import { writeStreamWithSummaryImpl, StreamWriteOptions } from "./transfer";

const DEFAULT_SMALL_FILE_THRESHOLD = 50_000;

interface SDKResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  text: string;
}

export class ObsidianDrive9SDKClient {
  baseUrl: string;
  apiKey: string;
  smallFileThreshold = DEFAULT_SMALL_FILE_THRESHOLD;
  private actor = "";
  private statusCache?: TenantStatus;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  updateConfig(baseUrl: string, apiKey: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.statusCache = undefined;
  }

  setActor(actor: string): void {
    this.actor = actor;
  }

  baseURL(): string {
    return this.baseUrl;
  }

  fsUrl(path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}/v1/fs${encodePath(p)}`;
  }

  authHeaders(init?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(init ?? {}) };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.actor) {
      headers["X-Dat9-Actor"] = this.actor;
    }
    return headers;
  }

  async provision(): Promise<{ api_key: string; status: string }> {
    return this.requestJSON<{ api_key: string; status: string }>("POST", "/v1/provision", {
      auth: false,
      headers: { "Content-Type": "application/json" },
    });
  }

  async status(): Promise<TenantStatus> {
    if (this.statusCache) return this.statusCache;
    this.statusCache = await this.requestJSON<TenantStatus>("GET", "/v1/status");
    if (typeof this.statusCache.inline_threshold === "number" && this.statusCache.inline_threshold > 0) {
      this.smallFileThreshold = this.statusCache.inline_threshold;
    }
    return this.statusCache;
  }

  async write(path: string, data: Uint8Array, options?: number | WriteOptions): Promise<void> {
    await this.writeWithRevision(path, data, options);
  }

  async writeWithRevision(path: string, data: Uint8Array, options?: number | WriteOptions): Promise<number> {
    const opts = normalizeWriteOptions(options);
    const headers = this.authHeaders({ "Content-Type": "application/octet-stream" });
    if (opts.expectedRevision >= 0) {
      headers["X-Dat9-Expected-Revision"] = String(opts.expectedRevision);
    }
    if (opts.description) {
      headers["X-Dat9-Description"] = opts.description;
    }
    appendTagHeaders(headers, opts.tags);

    const resp = await this.request("PUT", this.fsUrl(path), {
      absoluteUrl: true,
      headers,
      body: data,
      preAuthorized: true,
    });
    const body = resp.json as { revision?: number } | undefined;
    return body?.revision ?? 0;
  }

  async read(path: string): Promise<Uint8Array> {
    const resp = await this.request("GET", this.fsUrl(path), {
      absoluteUrl: true,
      headers: this.authHeaders(),
      preAuthorized: true,
    });
    return new Uint8Array(resp.arrayBuffer);
  }

  async stat(path: string): Promise<StatResult> {
    const resp = await this.request("HEAD", this.fsUrl(path), {
      absoluteUrl: true,
      headers: this.authHeaders(),
      preAuthorized: true,
    });
    const mtime = header(resp.headers, "x-dat9-mtime");
    const mode = header(resp.headers, "x-dat9-mode");
    const nlink = header(resp.headers, "x-dat9-nlink");
    return {
      size: Number(header(resp.headers, "content-length") ?? "0"),
      isDir: header(resp.headers, "x-dat9-isdir") === "true",
      revision: Number(header(resp.headers, "x-dat9-revision") ?? "0"),
      mtime: mtime ? new Date(Number(mtime) * 1000) : undefined,
      mode: mode ? Number(mode) : undefined,
      hasMode: mode != null,
      resource_id: header(resp.headers, "x-dat9-resource-id") ?? undefined,
      nlink: nlink ? Number(nlink) : undefined,
    };
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", this.fsUrl(path), {
      absoluteUrl: true,
      headers: this.authHeaders(),
      preAuthorized: true,
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.request("POST", `${this.fsUrl(newPath)}?rename`, {
      absoluteUrl: true,
      headers: this.authHeaders({ "X-Dat9-Rename-Source": oldPath }),
      preAuthorized: true,
    });
  }

  async mkdir(path: string, mode = 0o755): Promise<void> {
    const suffix = mode === 0o755 ? "?mkdir" : `?mkdir&mode=${encodeURIComponent(String(mode))}`;
    await this.request("POST", `${this.fsUrl(path)}${suffix}`, {
      absoluteUrl: true,
      headers: this.authHeaders(),
      preAuthorized: true,
    });
  }

  async list(path: string): Promise<FileInfo[]> {
    const body = await this.requestJSON<{
      entries?: Array<{ name: string; size: number; isDir: boolean; mtime?: number; mode?: number; hasMode?: boolean }>;
    }>("GET", `${this.fsUrl(path)}?list=1`, {
      absoluteUrl: true,
      headers: this.authHeaders(),
      preAuthorized: true,
    });
    return (body.entries ?? []).map((entry) => ({
      name: entry.name,
      size: entry.size,
      isDir: entry.isDir,
      mtime: entry.mtime != null ? new Date(entry.mtime * 1000) : undefined,
      mode: entry.mode,
      hasMode: entry.hasMode,
    }));
  }

  async grep(query: string, pathPrefix: string, limit = 0): Promise<SearchResult[]> {
    let url = `${this.fsUrl(pathPrefix)}?grep=${encodeURIComponent(query)}`;
    if (limit > 0) url += `&limit=${limit}`;
    const body = await this.requestJSON<unknown>("GET", url, {
      absoluteUrl: true,
      headers: this.authHeaders(),
      preAuthorized: true,
    });
    return Array.isArray(body) ? body as SearchResult[] : [];
  }

  async writeStreamWithSummary(
    path: string,
    data: Uint8Array,
    size: number,
    options?: number | StreamWriteOptions,
  ): Promise<UploadSummary> {
    return writeStreamWithSummaryImpl(this, path, data, size, options);
  }

  async postJSON<T = unknown>(endpoint: string, body: unknown): Promise<T> {
    return this.requestJSON<T>("POST", endpoint, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async putExternalPart(
    url: string,
    data: Uint8Array,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string> }> {
    const resp = await requestUrl({
      url,
      method: "PUT",
      body: toArrayBuffer(data),
      headers,
      throw: false,
    });
    return { status: resp.status, headers: resp.headers };
  }

  private async requestJSON<T>(
    method: string,
    urlPath: string,
    opts?: RequestOptions,
  ): Promise<T> {
    const resp = await this.request(method, urlPath, opts);
    return resp.json as T;
  }

  private async request(
    method: string,
    urlPath: string,
    opts?: RequestOptions,
  ): Promise<SDKResponse> {
    const url = opts?.absoluteUrl ? urlPath : `${this.baseUrl}${urlPath}`;
    const headers = opts?.preAuthorized
      ? { ...(opts.headers ?? {}) }
      : (opts?.auth === false ? { ...(opts.headers ?? {}) } : this.authHeaders(opts?.headers));
    const params: RequestUrlParam = {
      url,
      method,
      headers,
      throw: false,
    };
    if (opts?.body !== undefined) {
      params.body = typeof opts.body === "string" ? opts.body : toArrayBuffer(opts.body);
    }

    const resp = await requestUrl(params);
    if (resp.status >= 400) {
      throw statusError(errorMessage(resp), resp.status, serverRevision(resp));
    }
    return {
      status: resp.status,
      headers: resp.headers,
      json: resp.json,
      arrayBuffer: resp.arrayBuffer,
      text: resp.text,
    };
  }
}

interface RequestOptions {
  body?: string | ArrayBuffer | Uint8Array;
  headers?: Record<string, string>;
  auth?: boolean;
  absoluteUrl?: boolean;
  preAuthorized?: boolean;
}

function normalizeWriteOptions(
  options?: number | WriteOptions,
): Required<Pick<WriteOptions, "expectedRevision">> & Omit<WriteOptions, "expectedRevision"> {
  if (typeof options === "number") {
    return { expectedRevision: options };
  }
  return {
    expectedRevision: options?.expectedRevision ?? -1,
    tags: options?.tags,
    description: options?.description,
  };
}

function appendTagHeaders(headers: Record<string, string>, tags?: Record<string, string>): void {
  let i = 0;
  for (const [key, value] of Object.entries(tags ?? {})) {
    headers[i === 0 ? "X-Dat9-Tag" : `X-Dat9-Tag-${i}`] = `${key}=${value}`;
    i++;
  }
}

function errorMessage(resp: { status: number; json?: unknown; text?: string }): string {
  const body = resp.json as { error?: string; message?: string } | undefined;
  return body?.error ?? body?.message ?? resp.text ?? `HTTP ${resp.status}`;
}

function serverRevision(resp: { json?: unknown }): number | undefined {
  const body = resp.json as { server_revision?: unknown } | undefined;
  return typeof body?.server_revision === "number" ? body.server_revision : undefined;
}

function header(headers: Record<string, string>, name: string): string | null {
  const exact = headers[name];
  if (exact != null) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
