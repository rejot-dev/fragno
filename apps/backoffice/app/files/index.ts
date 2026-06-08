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
export { BUILT_IN_FILE_CONTRIBUTORS, getBuiltInFileContributors } from "./contributors";
export {
  RESEND_FILE_CONTRIBUTOR_ID,
  RESEND_FILE_MOUNT_ID,
  RESEND_FILE_MOUNT_POINT,
  resendFileContributor,
  resendFileMount,
} from "./contributors/resend";
export {
  STATIC_STARTER_FILE_CONTRIBUTOR_ID,
  STATIC_STARTER_FILE_MOUNT_ID,
  STATIC_STARTER_FILE_MOUNT_POINT,
  createStaticStarterFileSystem,
  staticStarterFileContributor,
  staticStarterFileMount,
} from "./contributors/static-starter";
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
  createUploadFileSystem,
  getConfiguredUploadProviders,
  isUploadConfigured,
  resolveBoundUploadProvider,
  resolvePreferredUploadProvider,
  resolveUploadFileMount,
  uploadFileContributor,
  uploadFileMount,
} from "./contributors/upload";
export { STATIC_STARTER_CONTENT, STATIC_STARTER_ROOT_DESCRIPTION } from "./content/starter";
export {
  STARTER_AUTOMATION_CONTENT,
  STARTER_AUTOMATION_SCRIPT_PATHS,
  STATIC_STARTER_ROOT,
} from "./content/automations";
export {
  BASH_HARNESS_REFERENCE,
  SYSTEM_FILE_CONTENT,
  SYSTEM_FILE_ROOT_DESCRIPTION,
  SYSTEM_GUIDANCE,
} from "./content/system";
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
