import type { FileTree } from "@/file-collection/file-collection";

export const MARKETPLACE_PACKAGE_ROOT_PATH = "/package";

export type MarketplacePackageSelectedContent = {
  path: string;
  text: string;
};

export type MarketplacePackageExplorerData =
  | {
      state: "ready";
      fileTree: FileTree;
      selectedVersion: string;
      /** Package path of the README shown as the package overview, or null without one. */
      overviewPath: string | null;
    }
  | {
      state: "unavailable" | "error";
      message: string;
    };
