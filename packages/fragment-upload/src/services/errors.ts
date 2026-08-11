export type UploadServiceErrorCode =
  | "FILE_ALREADY_EXISTS"
  | "FILE_DELETED"
  | "FILE_NOT_FOUND"
  | "FILE_PRECONDITION_FAILED"
  | "INVALID_CHECKSUM"
  | "INVALID_FILE_KEY"
  | "INVALID_REQUEST"
  | "PROVIDER_MISMATCH"
  | "STORAGE_ERROR"
  | "TEXT_INDEX_DISABLED"
  | "TEXT_SEARCH_REGEX_UNSUPPORTED"
  | "UPLOAD_ALREADY_ACTIVE"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_INVALID_STATE"
  | "UPLOAD_METADATA_MISMATCH"
  | "UPLOAD_NOT_FOUND";

export type UploadServiceErrorDetails = {
  uploadId?: string;
  provider?: string;
  fileKey?: string;
};

export class UploadServiceError extends Error {
  constructor(
    readonly code: UploadServiceErrorCode,
    message: string,
    readonly details?: UploadServiceErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UploadServiceError";
  }
}
