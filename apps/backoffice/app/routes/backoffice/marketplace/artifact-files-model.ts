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
      /** Artifact path of the README shown as the package overview, or null without one. */
      overviewPath: string | null;
    }
  | {
      state: "unavailable" | "error";
      message: string;
    };
