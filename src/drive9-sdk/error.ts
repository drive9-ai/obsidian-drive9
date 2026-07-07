// Obsidian-compatible subset of mem9-ai/drive9 clients/drive9-js@0.1.3.

export class Drive9SDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Drive9SDKError";
  }
}

export class StatusError extends Drive9SDKError {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "StatusError";
    this.statusCode = statusCode;
  }
}

export class ConflictError extends StatusError {
  serverRevision?: number;

  constructor(message: string, statusCode = 409, serverRevision?: number) {
    super(message, statusCode);
    this.name = "ConflictError";
    this.serverRevision = serverRevision;
  }
}

export function statusError(message: string, statusCode: number, serverRevision?: number): StatusError {
  if (statusCode === 409) {
    return new ConflictError(message, statusCode, serverRevision);
  }
  return new StatusError(message, statusCode);
}
