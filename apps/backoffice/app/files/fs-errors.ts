export type FileSystemErrorCode = "EINVAL" | "ENOENT" | "ENOTSUP" | "EROFS";

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;

  constructor(code: FileSystemErrorCode, message: string) {
    super(message);
    this.name = "FileSystemError";
    this.code = code;
  }
}

export const createPathNotFoundFileSystemError = (
  operation: string,
  path: string,
): FileSystemError =>
  new FileSystemError("ENOENT", `ENOENT: no such file or directory, ${operation} '${path}'`);

export const createUnsupportedOperationFileSystemError = (
  operation: string,
  path: string,
): FileSystemError =>
  new FileSystemError("ENOTSUP", `ENOTSUP: operation not supported, ${operation} '${path}'`);

export const createReadOnlyFileSystemError = (operation: string, path: string): FileSystemError =>
  new FileSystemError("EROFS", `EROFS: read-only file system, ${operation} '${path}'`);

export const createInvalidArgumentFileSystemError = (
  operation: string,
  path: string,
): FileSystemError =>
  new FileSystemError("EINVAL", `EINVAL: invalid argument, ${operation} '${path}'`);
