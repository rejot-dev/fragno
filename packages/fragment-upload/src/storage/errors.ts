export type UploadStorageErrorCode = "INVALID_CHECKSUM";

export class UploadStorageError extends Error {
  constructor(
    readonly code: UploadStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UploadStorageError";
  }
}
