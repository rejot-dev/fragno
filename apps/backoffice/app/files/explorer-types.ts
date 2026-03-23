import type { FileRootKind, FileRootPersistence } from "./types";

export const FILES_EXPLORER_NODE_KINDS = ["root", "folder", "file"] as const;
export type FilesExplorerNodeKind = (typeof FILES_EXPLORER_NODE_KINDS)[number];

export type FilesExplorerNode = {
  kind: FilesExplorerNodeKind;
  path: string;
  name: string;
  title: string;
  mountPoint: string;
  mountTitle: string;
  mountKind: FileRootKind;
  readOnly: boolean;
  persistence: FileRootPersistence;
  description?: string;
  sizeBytes?: number | null;
  contentType?: string | null;
  updatedAt?: string | Date | null;
  fileCount?: number;
  folderCount?: number;
};

export type FilesExplorerTreeNode = FilesExplorerNode & {
  children?: FilesExplorerTreeNode[];
};

export type FilesNodeField = {
  label: string;
  value: string;
};

export type FilesNodeCapabilities = {
  canCreateFolder: boolean;
  canWriteText: boolean;
  canDelete: boolean;
};

export type FilesNodeDetail = {
  node: FilesExplorerNode;
  description?: string;
  fields: FilesNodeField[];
  metadata?: Record<string, unknown> | null;
  textContent?: string | null;
  capabilities: FilesNodeCapabilities;
};
