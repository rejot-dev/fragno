import { assert, describe, expect, test } from "vitest";

import { createReadOnlyContentFileSystem } from "@/files/contributors/content";
import type { FilesExplorerTreeNode } from "@/files/explorer-types";

import {
  createPublishedMarketplaceArtifactFileSystem,
  loadMarketplaceArtifactExplorer,
} from "./artifact-files.server";

const SOURCE_MOUNT_POINT = "/marketplace-artifact-source";

const createArtifactSource = () =>
  createReadOnlyContentFileSystem(SOURCE_MOUNT_POINT, {
    "1.0.0/automations/daily-report.workflow.js": "export const version = '1.0.0';",
    "release-2/automations/daily-report.workflow.js": "export const version = '2.0.0';",
    "release-2/README.md": "# Version 2",
    "unpublished-draft/private.txt": "not published",
  });

const publishedVersions = [
  { version: "2.0.0", directory: "release-2" },
  { version: "1.0.0", directory: "1.0.0" },
] as const;

describe("Marketplace artifact filesystem", () => {
  test("shows every published version while hiding unreferenced Upload directories", async () => {
    const fileSystem = createPublishedMarketplaceArtifactFileSystem(
      createArtifactSource(),
      publishedVersions,
    );

    const result = await loadMarketplaceArtifactExplorer({ fileSystem });

    assert(result.state === "ready");
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]?.children?.map((node) => node.path)).toEqual([
      "/artifact/1.0.0/",
      "/artifact/2.0.0/",
    ]);

    const paths = flattenTreePaths(result.tree);
    expect(paths).toContain("/artifact/1.0.0/automations/daily-report.workflow.js");
    expect(paths).toContain("/artifact/2.0.0/README.md");
    assert(!paths.some((path) => path.includes("unpublished-draft")));
  });

  test("maps a visible version to its stored artifact directory and reads text through IFileSystem", async () => {
    const fileSystem = createPublishedMarketplaceArtifactFileSystem(
      createArtifactSource(),
      publishedVersions,
    );

    const result = await loadMarketplaceArtifactExplorer({
      fileSystem,
      requestedPath: "/artifact/2.0.0/README.md",
    });

    assert(result.state === "ready");
    expect(result.selectedDetail).toMatchObject({
      node: {
        path: "/artifact/2.0.0/README.md",
        title: "README.md",
      },
      textContent: "# Version 2",
    });
  });

  test("falls back to the artifact root when the selected file does not exist", async () => {
    const fileSystem = createPublishedMarketplaceArtifactFileSystem(
      createArtifactSource(),
      publishedVersions,
    );

    const result = await loadMarketplaceArtifactExplorer({
      fileSystem,
      requestedPath: "/artifact/2.0.0/missing.txt",
    });

    assert(result.state === "ready");
    assert(result.selectedPath === "/artifact");
    assert(result.selectedDetail?.node.kind === "root");
    expect(result.loadError).toContain("missing.txt");
  });
});

function flattenTreePaths(nodes: readonly FilesExplorerTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...flattenTreePaths(node.children ?? [])]);
}
