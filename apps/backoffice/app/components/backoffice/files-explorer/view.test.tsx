import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import type { FilesExplorerTreeNode, FilesNodeDetail } from "@/files";

import { FilesExplorerView } from "./view";

const fileNode: FilesExplorerTreeNode = {
  kind: "file",
  path: "/artifact/1.0.0/README.md",
  name: "README.md",
  title: "README.md",
  mountPoint: "/artifact",
  mountTitle: "Published versions",
  mountKind: "custom",
  readOnly: true,
  persistence: "persistent",
  contentType: "text/markdown",
};

const tree: FilesExplorerTreeNode[] = [
  {
    kind: "root",
    path: "/artifact",
    name: "artifact",
    title: "Published versions",
    mountPoint: "/artifact",
    mountTitle: "Published versions",
    mountKind: "custom",
    readOnly: true,
    persistence: "persistent",
    children: [fileNode],
  },
];

const selectedDetail: FilesNodeDetail = {
  node: fileNode,
  fields: [{ label: "Path", value: fileNode.path }],
  textContent: "# Published artifact",
  capabilities: {
    canCreateFolder: false,
    canWriteText: false,
    canDelete: false,
  },
};

describe("FilesExplorerView", () => {
  test("renders server-provided trees and details without local-first orchestration", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          tree={tree}
          selectedPath={fileNode.path}
          selectedDetail={selectedDetail}
          loadError={null}
          treeLabel="Published versions"
          treeAriaLabel="Marketplace artifact files"
          rootSelection="detail"
          detailHeadingLevel={4}
          buildNodeTo={(path) => ({ pathname: "/marketplace/example", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );

    assert(markup.includes("Marketplace artifact files"));
    assert(markup.includes("README.md"));
    assert(markup.includes("# Published artifact"));
    assert(!markup.includes("Download"));
  });

  test("renders downloads only when the caller supplies a download route", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          tree={tree}
          selectedPath={fileNode.path}
          selectedDetail={selectedDetail}
          loadError={null}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
          buildDownloadHref={(path) => `/files/download?path=${encodeURIComponent(path)}`}
        />
      </MemoryRouter>,
    );

    assert(markup.includes("Download"));
    assert(markup.includes("/files/download?path=%2Fartifact%2F1.0.0%2FREADME.md"));
  });
});
