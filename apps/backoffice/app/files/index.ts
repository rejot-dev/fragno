export type {
  FileContributor,
  FileEntryDescriptor,
  FileMountMetadata,
  FilesContext,
} from "./types";

export type { DirentEntry, IFileSystem } from "./interface";
export { createUnsupportedFileSystem } from "./interface";

export type { FilesExplorerTreeNode, FilesNodeDetail } from "./explorer-types";
export type { FilesActionResult } from "./actions";
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
export { SYSTEM_FILE_CONTENT, SYSTEM_GUIDANCE } from "./content/system";
export { MasterFileSystem, createMasterFileSystem } from "./master-file-system";

export { createOrgFileSystem } from "./create-file-system";

export {
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  resolveFilesTarget,
} from "./service";
export { ensureFolderPath, normalizeRelativePath, stripTrailingSlash } from "./normalize-path";
