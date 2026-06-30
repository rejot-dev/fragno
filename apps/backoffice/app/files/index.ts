export type {
  FileContributor,
  FileEntryDescriptor,
  FileMountMetadata,
  FilesContext,
} from "./types";
export type { DirentEntry, IFileSystem } from "./interface";
export { createUnsupportedFileSystem } from "./interface";

export type { FileGroup, FileNodePermissions, FilePrincipal, FileSubject } from "./permissions";
export {
  ROOT_FILE_NODE_PERMISSIONS,
  ROOT_FILE_PRINCIPAL,
  resolveActorFilePrincipal,
  sameFileGroup,
  sameFileSubject,
} from "./permissions";
export type {
  FilesExplorerNode,
  FilesExplorerNodeKind,
  FilesExplorerTreeNode,
  FilesNodeCapabilities,
  FilesNodeDetail,
  FilesNodeField,
} from "./explorer-types";
export type { FilesActionIntent, FilesActionResult } from "./actions";
export { performFilesAction } from "./actions";
export { getBuiltInFileContributors } from "./contributors";

export {
  STATIC_FILE_MOUNT_POINT,
  staticFileContributor,
  staticFileMount,
} from "./contributors/static";

export {
  createUploadFileSystem,
  resolveUploadFileMount,
  uploadFileContributor,
} from "./contributors/upload";
export { WORKSPACE_STARTER_CONTENT } from "./content/starter";
export { SYSTEM_AUTOMATION_SCRIPT_PATHS } from "./content/system-automations";
export { STARTER_AUTOMATION_SCRIPT_PATHS } from "./content/starter-automations";
export {
  SYSTEM_FILE_CONTENT,
  SYSTEM_MD as SYSTEM_GUIDANCE,
  renderSystemGuidance,
} from "./content/system";
export { MasterFileSystem, createMasterFileSystem } from "./master-file-system";
export type { CreateMasterFileSystemOptions } from "./master-file-system";
export { createBackofficeFileSystem } from "./create-file-system";
export type { CreateBackofficeFileSystemOptions } from "./create-file-system";
export { createSystemFilesContext } from "./system-context";
export {
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  resolveFilesTarget,
} from "./service";
export { ensureFolderPath, normalizeRelativePath, stripTrailingSlash } from "./normalize-path";
