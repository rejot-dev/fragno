import type { FileTree } from "@/file-collection/file-collection";

export const MARKETPLACE_ARTIFACT_ROOT_PATH = "/artifact";

export type MarketplaceArtifactSelectedContent = {
  path: string;
  text: string;
};

export type MarketplaceArtifactExplorerData =
  | {
      state: "ready";
      fileTree: FileTree;
      selectedVersion: string;
    }
  | {
      state: "unavailable" | "error";
      message: string;
    };
