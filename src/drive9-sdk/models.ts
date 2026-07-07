// Obsidian-compatible subset of mem9-ai/drive9 clients/drive9-js@0.1.3.

export interface FileInfo {
  name: string;
  size: number;
  isDir: boolean;
  mtime?: Date;
  mode?: number;
  hasMode?: boolean;
}

export interface StatResult {
  size: number;
  isDir: boolean;
  revision: number;
  mtime?: Date;
  mode?: number;
  hasMode?: boolean;
  resource_id?: string;
  nlink?: number;
}

export interface SearchResult {
  path: string;
  name: string;
  size_bytes: number;
  score?: number;
}

export interface TenantStatus {
  status?: string;
  inline_threshold?: number;
  max_upload_bytes?: number;
  [key: string]: unknown;
}

export interface WriteOptions {
  expectedRevision?: number;
  tags?: Record<string, string>;
  description?: string;
}

export interface CompletePart {
  number: number;
  etag: string;
}

export interface PresignedPart {
  number: number;
  url: string;
  size: number;
  headers?: Record<string, unknown>;
}

export interface UploadPlanV2 {
  upload_id: string;
  key: string;
  part_size: number;
  total_parts: number;
  expires_at?: string;
  resumable?: boolean;
  checksum_contract?: {
    supported?: string[];
    required?: boolean;
  };
}

export interface UploadSummary {
  type: "upload";
  mode: "direct_put" | "multipart_v2";
  started_at: string;
  finished_at: string;
  elapsed_seconds: number;
  remote_path: string;
  total_bytes: number;
  part_size_bytes?: number;
  total_parts?: number;
  uploaded_parts?: number;
}
