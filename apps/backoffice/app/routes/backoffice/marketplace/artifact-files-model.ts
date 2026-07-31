import type { FilesExplorerTreeNode, FilesNodeDetail } from "@/files/explorer-types";

export const MARKETPLACE_ARTIFACT_MOUNT_POINT = "/artifact";

export type MarketplaceArtifactExplorerData =
  | {
      state: "ready";
      tree: FilesExplorerTreeNode[];
      selectedPath: string;
      selectedDetail: FilesNodeDetail | null;
      loadError: string | null;
    }
  | {
      state: "unavailable" | "error";
      message: string;
    };
