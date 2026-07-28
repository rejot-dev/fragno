export type UploadServiceErrorCode = "FILE_PRECONDITION_FAILED";

export class UploadServiceError extends Error {
  constructor(
    readonly code: UploadServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UploadServiceError";
  }
}
