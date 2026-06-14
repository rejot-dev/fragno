export type {
  FileContributor,
  FileEntryDescriptor,
  FileEntryKind,
  FileMountMetadata,
  FileRootKind,
  FileRootPersistence,
  FilesBackend,
  FilesContext,
  FileSystemArtifact,
  FileSystemResolution,
  ResolvedFileMount,
} from "./types";

export type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  SymlinkEntry,
  WriteFileOptions,
} from "./interface";
export { createUnsupportedFileSystem } from "./interface";

export { FILE_BACKEND, FILE_ENTRY_KINDS, FILE_ROOT_KINDS, FILE_ROOT_PERSISTENCE } from "./types";
export type {
  FilesExplorerNode,
  FilesExplorerNodeKind,
  FilesExplorerTreeNode,
  FilesNodeCapabilities,
  FilesNodeDetail,
  FilesNodeField,
} from "./explorer-types";
export { FILES_EXPLORER_NODE_KINDS } from "./explorer-types";
export type { FilesActionIntent, FilesActionResult } from "./actions";
export { FILES_ACTION_INTENTS, performFilesAction } from "./actions";
export { getBuiltInFileContributors } from "./contributors";
export {
  RESEND_FILE_CONTRIBUTOR_ID,
  RESEND_FILE_MOUNT_ID,
  RESEND_FILE_MOUNT_POINT,
  resendFileContributor,
  resendFileMount,
} from "./contributors/resend";
export {
  STATIC_FILE_CONTRIBUTOR_ID,
  STATIC_FILE_MOUNT_ID,
  STATIC_FILE_MOUNT_POINT,
  staticFileContributor,
  staticFileMount,
} from "./contributors/static";
export {
  automationHooksFileContributor,
  createDurableHooksFileContributor,
} from "./contributors/durable-hooks";
export type { DurableHooksContributorOptions } from "./contributors/durable-hooks";
export {
  UPLOAD_FILE_CONTRIBUTOR_ID,
  UPLOAD_FILE_MOUNT_ID,
  UPLOAD_FILE_MOUNT_POINT,
  UPLOAD_R2_BINDING_FILE_MOUNT_ID,
  UPLOAD_R2_BINDING_FILE_MOUNT_POINT,
  UPLOAD_R2_REMOTE_FILE_MOUNT_ID,
  UPLOAD_R2_REMOTE_FILE_MOUNT_POINT,
  createUploadFileSystem,
  getConfiguredUploadProviders,
  isUploadConfigured,
  resolveBoundUploadProvider,
  resolvePreferredUploadProvider,
  resolveUploadFileMount,
  uploadFileContributor,
  uploadFileMount,
  uploadR2BindingFileContributor,
  uploadR2BindingFileMount,
  uploadR2RemoteFileContributor,
  uploadR2RemoteFileMount,
} from "./contributors/upload";
export { WORKSPACE_STARTER_CONTENT, WORKSPACE_STARTER_ROOT_DESCRIPTION } from "./content/starter";
export {
  SYSTEM_AUTOMATION_SCRIPT_PATHS,
  SYSTEM_AUTOMATION_CONTENT,
} from "./content/system-automations";
export {
  STARTER_AUTOMATION_SCRIPT_PATHS,
  WORKSPACE_STARTER_AUTOMATION_CONTENT,
} from "./content/starter-automations";
export { SYSTEM_FILE_CONTENT, SYSTEM_GUIDANCE } from "./content/system";
export { MasterFileSystem, createMasterFileSystem } from "./master-file-system";
export type { CreateMasterFileSystemOptions } from "./master-file-system";
export { createOrgFileSystem } from "./create-file-system";
export type { CreateOrgFileSystemOptions } from "./create-file-system";
export {
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  resolveFilesTarget,
} from "./service";
export {
  ensureFolderPath,
  isExactMountPointMatch,
  isMountPointParentOf,
  normalizeAbsolutePath,
  normalizeDirectoryPath,
  normalizeFolderPath,
  normalizeMountPoint,
  normalizePathSegments,
  normalizeRelativePath,
  resolvePath,
  stripTrailingSlash,
} from "./normalize-path";
