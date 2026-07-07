// Obsidian-compatible subset of mem9-ai/drive9 clients/drive9-js@0.1.3.

import { Drive9SDKError, StatusError } from "./error";
import type {
  CompletePart,
  PresignedPart,
  UploadPlanV2,
  UploadSummary,
  WriteOptions,
} from "./models";
import { Semaphore } from "./utils";
import type { ObsidianDrive9SDKClient } from "./obsidian-client";

export type UploadProgressFn = (partNumber: number, totalParts: number) => void;

export interface StreamWriteOptions extends WriteOptions {
  onProgress?: UploadProgressFn;
}

const UPLOAD_MAX_CONCURRENCY = 16;
const UPLOAD_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function uploadParallelism(partSize: number): number {
  const byMemory = Math.max(1, Math.floor(UPLOAD_MAX_BUFFER_BYTES / partSize));
  return Math.min(byMemory, UPLOAD_MAX_CONCURRENCY);
}

function normalizeWriteOptions(
  options?: number | StreamWriteOptions,
): Required<Pick<StreamWriteOptions, "expectedRevision">> & Omit<StreamWriteOptions, "expectedRevision"> {
  if (typeof options === "number") {
    return { expectedRevision: options };
  }
  return {
    expectedRevision: options?.expectedRevision ?? -1,
    tags: options?.tags,
    description: options?.description,
    onProgress: options?.onProgress,
  };
}

function uploadSummary(
  path: string,
  size: number,
  mode: UploadSummary["mode"],
  started: Date,
  partSize?: number,
  totalParts?: number,
  uploadedParts?: number,
): UploadSummary {
  const finished = new Date();
  return {
    type: "upload",
    mode,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    elapsed_seconds: (finished.getTime() - started.getTime()) / 1000,
    remote_path: path,
    total_bytes: size,
    part_size_bytes: partSize,
    total_parts: totalParts,
    uploaded_parts: uploadedParts,
  };
}

function expectedRevisionPayload(expectedRevision: number): { expected_revision?: number } {
  return expectedRevision >= 0 ? { expected_revision: expectedRevision } : {};
}

export async function writeStreamWithSummaryImpl(
  client: ObsidianDrive9SDKClient,
  path: string,
  data: Uint8Array,
  size: number,
  options?: number | StreamWriteOptions,
): Promise<UploadSummary> {
  const opts = normalizeWriteOptions(options);
  const started = new Date();

  if (size === 0 || size < client.smallFileThreshold) {
    await client.writeWithRevision(path, data, opts);
    return uploadSummary(path, size, "direct_put", started);
  }

  try {
    const plan = await writeStreamV2(client, path, data, opts);
    return uploadSummary(path, size, "multipart_v2", started, plan.part_size, plan.total_parts, plan.total_parts);
  } catch (err) {
    const status = err instanceof StatusError ? err.statusCode : 0;
    const msg = err instanceof Error ? err.message : String(err);
    if (status === 404 || msg.includes("v2 upload API not available")) {
      await client.writeWithRevision(path, data, opts);
      return uploadSummary(path, size, "direct_put", started);
    }
    throw err;
  }
}

async function writeStreamV2(
  client: ObsidianDrive9SDKClient,
  path: string,
  data: Uint8Array,
  options: Required<Pick<StreamWriteOptions, "expectedRevision">> & Omit<StreamWriteOptions, "expectedRevision">,
): Promise<UploadPlanV2> {
  const plan = await initiateUploadV2(client, path, data.length, options.expectedRevision, options.description || "");
  try {
    const parts = await uploadPartsV2(client, plan, data, options.onProgress);
    await completeUploadV2(client, plan.upload_id, parts, options.tags);
    return plan;
  } catch (err) {
    await abortUploadV2(client, plan.upload_id);
    throw err;
  }
}

async function initiateUploadV2(
  client: ObsidianDrive9SDKClient,
  path: string,
  size: number,
  expectedRevision: number,
  description: string,
): Promise<UploadPlanV2> {
  try {
    return await client.postJSON<UploadPlanV2>("/v2/uploads/initiate", {
      path,
      total_size: size,
      ...expectedRevisionPayload(expectedRevision),
      description,
    });
  } catch (err) {
    if (err instanceof StatusError && err.statusCode === 404) {
      throw new Drive9SDKError("v2 upload API not available");
    }
    throw err;
  }
}

async function uploadPartsV2(
  client: ObsidianDrive9SDKClient,
  plan: UploadPlanV2,
  data: Uint8Array,
  onProgress?: UploadProgressFn,
): Promise<CompletePart[]> {
  const partSize = plan.part_size;
  const totalParts = Math.max(1, Math.ceil(data.length / partSize));
  const semaphore = new Semaphore(uploadParallelism(partSize));
  const results = Array<CompletePart | undefined>(totalParts).fill(undefined);
  const tasks: Promise<void>[] = [];

  for (let i = 1; i <= totalParts; i++) {
    const partNumber = i;
    tasks.push((async () => {
      await semaphore.acquire();
      try {
        const offset = (partNumber - 1) * partSize;
        const chunk = data.subarray(offset, Math.min(offset + partSize, data.length));
        const presigned = await presignOnePart(client, plan.upload_id, partNumber);
        const etag = await uploadOnePartV2(client, plan.upload_id, presigned, chunk);
        results[partNumber - 1] = { number: partNumber, etag };
        onProgress?.(partNumber, totalParts);
      } finally {
        semaphore.release();
      }
    })());
  }

  await Promise.all(tasks);
  return results.filter((part): part is CompletePart => part !== undefined);
}

async function presignOnePart(
  client: ObsidianDrive9SDKClient,
  uploadId: string,
  partNumber: number,
): Promise<PresignedPart> {
  return client.postJSON<PresignedPart>(
    `/v2/uploads/${uploadId}/presign`,
    { part_number: partNumber },
  );
}

async function uploadOnePartV2(
  client: ObsidianDrive9SDKClient,
  uploadId: string,
  part: PresignedPart,
  data: Uint8Array,
): Promise<string> {
  let resp = await client.putExternalPart(part.url, data, presignedHeaders(part));
  if (resp.status === 403) {
    const fresh = await presignOnePart(client, uploadId, part.number);
    resp = await client.putExternalPart(fresh.url, data, presignedHeaders(fresh));
  }
  if (resp.status >= 300) {
    throw new StatusError(`part upload failed: HTTP ${resp.status}`, resp.status);
  }
  return resp.headers["etag"] ?? resp.headers["ETag"] ?? "";
}

function presignedHeaders(part: PresignedPart): Record<string, string> {
  const headers: Record<string, string> = {};
  if (part.headers) {
    for (const [key, value] of Object.entries(part.headers)) {
      if (typeof value === "string" && key.toLowerCase() !== "host") {
        headers[key] = value;
      }
    }
  }
  return headers;
}

async function completeUploadV2(
  client: ObsidianDrive9SDKClient,
  uploadId: string,
  parts: CompletePart[],
  tags?: Record<string, string>,
): Promise<void> {
  await client.postJSON(`/v2/uploads/${uploadId}/complete`, { parts, tags });
}

async function abortUploadV2(client: ObsidianDrive9SDKClient, uploadId: string): Promise<void> {
  try {
    await client.postJSON(`/v2/uploads/${uploadId}/abort`, {});
  } catch {
    // Abort is best-effort.
  }
}
