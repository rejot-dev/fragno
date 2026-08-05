// @vitest-environment happy-dom

import { afterEach, assert, describe, test } from "vitest";

import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { createFileTree } from "@/file-collection/create-file-tree";

import { FilesExplorerView, type FilesExplorerSource } from "./view";

afterEach(cleanup);

const filePath = "/artifact/1.0.0/README.md";
const source: FilesExplorerSource = {
  tree: createFileTree([
    {
      kind: "file",
      path: "1.0.0/README.md",
      sizeBytes: 20,
      contentType: "text/markdown",
      updatedAt: null,
      metadata: null,
    },
  ]),
  rootPath: "/artifact",
  rootTitle: "Published versions",
};

describe("FilesExplorerView", () => {
  test("renders FileTree sources without caller-owned explorer nodes", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          sources={[source]}
          selectedPath={filePath}
          selectedContent={{ path: filePath, text: "# Published artifact" }}
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
    assert(markup.includes("<h1"));
    assert(markup.includes("Published artifact"));
    assert(!markup.includes("Download"));
  });

  test("formats updated timestamps in UTC for deterministic server rendering", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          sources={[
            {
              ...source,
              tree: createFileTree([
                {
                  kind: "file",
                  path: "1.0.0/README.md",
                  sizeBytes: 20,
                  contentType: "text/markdown",
                  updatedAt: "2026-01-01T12:00:00.000Z",
                  metadata: null,
                },
              ]),
            },
          ]}
          selectedPath={filePath}
          loadError={null}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );

    assert(markup.includes("Jan 1, 2026, 12:00 PM"));
  });

  test("renders only public file metadata", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          sources={[
            {
              ...source,
              tree: createFileTree([
                {
                  kind: "file",
                  path: "1.0.0/README.md",
                  sizeBytes: 20,
                  contentType: "text/markdown",
                  updatedAt: null,
                  metadata: {
                    provider: "database",
                    filename: "README.md",
                    status: "ready",
                    visibility: "public",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    previewUrl: "/preview/README.md",
                    fileKey: "internal/README.md",
                    uploadId: "upload-internal",
                    uploaderId: "user-internal",
                    customInternalValue: "hidden",
                  },
                },
              ]),
            },
          ]}
          selectedPath={filePath}
          loadError={null}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );

    assert(markup.includes("database"));
    assert(markup.includes("/preview/README.md"));
    assert(!markup.includes("internal/README.md"));
    assert(!markup.includes("upload-internal"));
    assert(!markup.includes("user-internal"));
    assert(!markup.includes("customInternalValue"));
  });

  test("supports route-owned default root expansion", () => {
    const workspaceFilePath = "/workspace/private.txt";
    const workspaceSource: FilesExplorerSource = {
      tree: createFileTree([
        {
          kind: "file",
          path: "private.txt",
          sizeBytes: 7,
          contentType: "text/plain",
          updatedAt: null,
          metadata: null,
        },
      ]),
      rootPath: "/workspace",
      rootTitle: "Workspace",
    };

    const collapsedMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          sources={[workspaceSource, source]}
          selectedPath="/artifact"
          loadError={null}
          defaultCollapsedRootPaths={["/workspace"]}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );
    assert(collapsedMarkup.includes("Expand Workspace"));
    assert(!collapsedMarkup.includes("private.txt"));

    const selectedChildMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          sources={[workspaceSource, source]}
          selectedPath={workspaceFilePath}
          loadError={null}
          defaultCollapsedRootPaths={["/workspace"]}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );
    assert(selectedChildMarkup.includes("Collapse Workspace"));
    assert(selectedChildMarkup.includes("private.txt"));
  });

  test("toggles a root by clicking the root itself", () => {
    const workspaceSource: FilesExplorerSource = {
      tree: createFileTree([
        {
          kind: "file",
          path: "visible.txt",
          sizeBytes: 7,
          contentType: "text/plain",
          updatedAt: null,
          metadata: null,
        },
      ]),
      rootPath: "/workspace",
      rootTitle: "Workspace",
    };

    render(
      <MemoryRouter>
        <FilesExplorerView
          sources={[workspaceSource]}
          selectedPath="/workspace"
          loadError={null}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );

    const root = screen.getByRole("button", { name: "Collapse Workspace" });
    assert(!root.className.includes("active:scale"));
    screen.getByText("visible.txt");

    fireEvent.click(root);
    screen.getByRole("button", { name: "Expand Workspace" });
    assert(screen.queryByText("visible.txt") === null);
  });

  test("allows a root to close while one of its files is selected", () => {
    const nestedSource = createNestedWorkspaceSource();
    render(
      <ExplorerHarness source={nestedSource} initialSelectedPath="/workspace/notes/todo.txt" />,
    );

    assert(screen.getAllByText("todo.txt").length > 0);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Workspace" }));

    screen.getByRole("button", { name: "Expand Workspace" });
    assert(screen.queryByRole("link", { name: "notes" }) === null);
  });

  test("collapses and restores the complete file tree on smaller screens", () => {
    render(<ExplorerHarness source={source} initialSelectedPath={filePath} />);

    const toggle = screen.getByRole("button", { name: "Hide file tree" });
    const tree = document.getElementById("files-explorer-tree");
    assert(tree);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert(tree.className.includes("hidden lg:block"));

    fireEvent.click(screen.getByRole("button", { name: "Show file tree" }));
    assert(!tree.className.includes("hidden lg:block"));
  });

  test("starts folders collapsed and expands them when their row is selected", () => {
    const nestedSource = createNestedWorkspaceSource();
    render(<ExplorerHarness source={nestedSource} initialSelectedPath="/workspace" />);

    const folderLink = screen.getByRole("link", { name: "notes" });
    assert(screen.queryByText("todo.txt") === null);

    fireEvent.click(folderLink);
    screen.getByText("todo.txt");
  });

  test("keeps a selected file open when its parent folder is pressed", () => {
    const nestedSource = createNestedWorkspaceSource();
    render(
      <ExplorerHarness source={nestedSource} initialSelectedPath="/workspace/notes/todo.txt" />,
    );

    assert(screen.getAllByText("todo.txt").length > 0);
    fireEvent.click(screen.getByRole("link", { name: "notes" }));

    screen.getByRole("heading", { name: "todo.txt" });
    assert(screen.queryByRole("link", { name: "todo.txt" }) === null);
  });

  test("navigates to unrelated folders while a file is selected", () => {
    const nestedSource: FilesExplorerSource = {
      ...createNestedWorkspaceSource(),
      tree: createFileTree([
        {
          kind: "file",
          path: "notes/todo.txt",
          sizeBytes: 4,
          contentType: "text/plain",
          updatedAt: null,
          metadata: null,
        },
        {
          kind: "file",
          path: "archive/done.txt",
          sizeBytes: 4,
          contentType: "text/plain",
          updatedAt: null,
          metadata: null,
        },
      ]),
    };
    render(
      <ExplorerHarness source={nestedSource} initialSelectedPath="/workspace/notes/todo.txt" />,
    );

    fireEvent.click(screen.getByRole("link", { name: "archive" }));

    screen.getByRole("heading", { name: "archive" });
  });

  test("renders downloads only when the caller supplies a download route", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerView
          sources={[source]}
          selectedPath={filePath}
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
function createNestedWorkspaceSource(): FilesExplorerSource {
  return {
    tree: createFileTree([
      {
        kind: "file",
        path: "notes/todo.txt",
        sizeBytes: 4,
        contentType: "text/plain",
        updatedAt: null,
        metadata: null,
      },
    ]),
    rootPath: "/workspace",
    rootTitle: "Workspace",
  };
}

function ExplorerHarness({
  source,
  initialSelectedPath,
}: {
  source: FilesExplorerSource;
  initialSelectedPath: string;
}) {
  const [selectedPath, setSelectedPath] = useState(initialSelectedPath);
  return (
    <MemoryRouter>
      <FilesExplorerView
        sources={[source]}
        selectedPath={selectedPath}
        loadError={null}
        onNodeSelect={(node) => setSelectedPath(node.path)}
        buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
      />
    </MemoryRouter>
  );
}
