export type {
  FileContributor,
  FileEntryDescriptor,
  FileMountMetadata,
  FilesContext,
} from "./types";
export { emptyStaticFileArtifacts } from "./types";
export type { DirentEntry, IFileSystem } from "./interface";
export { createUnsupportedFileSystem } from "./interface";

export type { FilePrincipal } from "./permissions";
export { ROOT_FILE_PRINCIPAL } from "./permissions";
export { getBuiltInFileContributors } from "./contributors";

export {
  STATIC_FILE_MOUNT_POINT,
  staticFileContributor,
  staticFileMount,
  systemFileContributor,
} from "./contributors/static";

export {
  createUploadFileSystem,
  resolveUploadFileMount,
  UploadFileWriteConflictError,
  uploadFileContributor,
} from "./contributors/upload";
export type { UploadFileSystem, UploadFileWritePrecondition } from "./contributors/upload";
export { WORKSPACE_STARTER_CONTENT } from "./content/starter";
export { STATIC_AUTOMATION_SCRIPT_PATHS } from "./content/static-automations";
export { SYSTEM_AUTOMATION_SCRIPT_PATHS } from "./content/system-automations";
export { STATIC_FILE_CONTENT } from "./content/static";
export { SYSTEM_FILE_CONTENT } from "./content/system";
export { MasterFileSystem, createMasterFileSystem } from "./master-file-system";
export { createBackofficeFileSystem } from "./create-file-system";
export { createSystemFilesContext } from "./system-context";
export { ensureFolderPath, normalizeRelativePath, stripTrailingSlash } from "./normalize-path";
