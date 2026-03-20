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
  MountedFileSystem,
  MountedFileSystemCapabilities,
  MountedFileSystemInput,
  MountedFileSystemResolution,
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
  IIFileSystem,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  SymlinkEntry,
  WriteFileOptions,
} from "./interface";

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
export {
  getRegisteredFileContributor,
  getRegisteredFileContributors,
  registerFileContributor,
  resetFileContributorsForTest,
} from "./registry";
export { ensureBuiltInFileContributorsRegistered } from "./contributors";
export {
  STARTER_FILE_CONTRIBUTOR_ID,
  STARTER_FILE_MOUNT_ID,
  STARTER_FILE_MOUNT_POINT,
  createStarterMountedFileSystem,
  starterFileContributor,
  starterFileMount,
} from "./contributors/starter";
export {
  STATIC_FILE_CONTRIBUTOR_ID,
  STATIC_FILE_MOUNT_ID,
  STATIC_FILE_MOUNT_POINT,
  staticFileContributor,
  staticFileMount,
} from "./contributors/static";
export {
  UPLOAD_FILE_CONTRIBUTOR_ID,
  UPLOAD_FILE_MOUNT_ID,
  UPLOAD_FILE_MOUNT_POINT,
  createUploadMountedFileSystem,
  getConfiguredUploadProviders,
  isUploadConfigured,
  resolveBoundUploadProvider,
  resolvePreferredUploadProvider,
  resolveUploadFileMount,
  resolveUploadMountConfig,
  uploadFileContributor,
  uploadFileMount,
} from "./contributors/upload";
export { STARTER_WORKSPACE_CONTENT, STARTER_WORKSPACE_ROOT_DESCRIPTION } from "./content/starter";
export {
  STARTER_AUTOMATION_CONTENT,
  STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH,
  STARTER_AUTOMATION_ROOT,
  STARTER_AUTOMATION_SCRIPT_PATHS,
  starterTelegramClaimLinkingCompleteScript,
  starterTelegramClaimLinkingStartScript,
  starterTelegramPiSessionStartScript,
} from "./content/automations";
export { SYSTEM_FILE_CONTENT, SYSTEM_FILE_ROOT_DESCRIPTION } from "./content/system";
export { normalizeMountedFileSystem } from "./mounted-file-system";
export type { NormalizeMountedFileSystemOptions } from "./mounted-file-system";
export { MasterFileSystem, createMasterFileSystem } from "./master-file-system";
export {
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  resolveFilesTarget,
} from "./service";
export {
  isExactMountPointMatch,
  isMountPointParentOf,
  normalizeMountPoint,
  normalizePathSegments,
  normalizeRelativePath,
} from "./normalize-path";
export {
  BOOTSTRAP_SENTINEL_PATH,
  hasBootstrapSentinel,
  prepareSandboxFileSystem,
  writeArtifactToSandbox,
} from "./prepare-sandbox-filesystem";
export type {
  PrepareSandboxFileSystemOptions,
  ResolveUploadMount,
  SandboxBootstrapMarker,
  UploadMountConfig,
} from "./prepare-sandbox-filesystem";
