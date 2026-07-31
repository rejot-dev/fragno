import type { FilesExplorerTreeNode, FilesNodeDetail } from "@/files/explorer-types";

export const MARKETPLACE_ARTIFACT_MOUNT_POINT = "/artifact";

export type MarketplaceArtifactSelectedContent = {
  path: string;
  text: string;
};

export type MarketplaceArtifactWorkflowSource = {
  path: string;
  source: string;
};

export type MarketplaceArtifactExplorerData =
  | {
      state: "ready";
      tree: FilesExplorerTreeNode[];
      selectedVersion: string;
      defaultPath: string;
      detailsByPath: Record<string, FilesNodeDetail>;
      overviewPath: string | null;
    }
  | {
      state: "unavailable" | "error";
      message: string;
    };
