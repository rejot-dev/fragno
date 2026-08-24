// @vitest-environment happy-dom

import { afterEach, assert, describe, test } from "vitest";

import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { createFileTree } from "@/file-collection/create-file-tree";

import {
  FilesExplorerView as FilesExplorerViewComponent,
  type FilesExplorerSource,
  type FilesExplorerViewProps,
} from "./view";

afterEach(cleanup);

const filePath = "/artifact/1.0.0/README.md";
function FilesExplorerView(props: Omit<FilesExplorerViewProps, "workflowRouting">) {
  return <FilesExplorerViewComponent {...props} workflowRouting={{ status: "unavailable" }} />;
}

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

  test("shows only routes that start the selected workflow path", () => {
    const workflowPath = "/workspace/automations/telegram-user-linking.workflow.js";
    const route = {
      id: "telegram-start-linking",
      name: "Telegram /start identity linking",
      enabled: true,
      priority: 100,
      trigger: {
        kind: "event" as const,
        source: "telegram",
        eventType: "message.received",
        matcher: { path: "$.payload.text", op: "eq" as const, value: "/start" },
      },
      action: {
        kind: "start_workflow" as const,
        authority: { kind: "organization-automation" as const },
        workflowScriptPath: workflowPath,
        instanceIdTemplate: "telegram-link-${event.id}",
      },
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FilesExplorerViewComponent
          sources={[
            {
              tree: createFileTree([
                {
                  kind: "file",
                  path: "automations/telegram-user-linking.workflow.js",
                  sizeBytes: 128,
                  contentType: "text/javascript",
                  updatedAt: null,
                  metadata: null,
                },
              ]),
              rootPath: "/workspace",
              rootTitle: "Workspace",
            },
          ]}
          selectedPath={workflowPath}
          selectedContent={{
            path: workflowPath,
            text: 'defineWorkflow({ name: "telegram-user-linking" }, async () => {});',
          }}
          loadError={null}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
          workflowRouting={{
            status: "ready",
            routes: [
              { ...route, nextOccurrenceAt: null },
              {
                ...route,
                id: "other-workflow",
                name: "Unrelated workflow route",
                action: {
                  ...route.action,
                  workflowScriptPath: "/workspace/automations/other.workflow.js",
                },
                nextOccurrenceAt: null,
              },
            ],
          }}
        />
      </MemoryRouter>,
    );

    assert(markup.includes("Telegram /start identity linking"));
    assert(markup.includes("telegram / message.received"));
    assert(markup.includes("$.payload.text equals &quot;/start&quot;"));
    assert(!markup.includes("Unrelated workflow route"));
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
    assert(tree.className.includes("hidden md:flex"));

    fireEvent.click(screen.getByRole("button", { name: "Show file tree" }));
    assert(!tree.className.includes("hidden md:flex"));
  });

  test("starts folders collapsed and expands them when their row is selected", () => {
    const nestedSource = createNestedWorkspaceSource();
    render(<ExplorerHarness source={nestedSource} initialSelectedPath="/workspace" />);

    const folderLink = screen.getByRole("link", { name: "notes" });
    assert(screen.queryByText("todo.txt") === null);

    fireEvent.click(folderLink);
    screen.getByText("todo.txt");
  });

  test("expands a directory selected by the current route", () => {
    render(
      <ExplorerHarness
        source={createNestedWorkspaceSource()}
        initialSelectedPath="/workspace/notes/"
      />,
    );

    screen.getByRole("heading", { name: "notes" });
    screen.getByRole("link", { name: "todo.txt" });
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

  test("filters the tree by file and folder name while preserving ancestors", () => {
    render(
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
                  metadata: null,
                },
                {
                  kind: "file",
                  path: "1.0.0/LICENSE.txt",
                  sizeBytes: 12,
                  contentType: "text/plain",
                  updatedAt: null,
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

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter file or folder names" }), {
      target: { value: "license" },
    });

    screen.getByText("1 matching name");
    screen.getByRole("link", { name: "LICENSE.txt" });
    assert(screen.queryByRole("link", { name: "README.md" }) === null);
    screen.getByRole("link", { name: "1.0.0" });

    fireEvent.click(screen.getByRole("button", { name: "Clear file name filter" }));
    screen.getByRole("link", { name: "README.md" });
    screen.getByRole("link", { name: "LICENSE.txt" });
  });

  test("hides content search when the explorer does not provide it", () => {
    render(
      <MemoryRouter>
        <FilesExplorerView
          sources={[source]}
          selectedPath={filePath}
          loadError={null}
          buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
        />
      </MemoryRouter>,
    );

    assert(screen.queryByRole("searchbox", { name: "Search file contents" }) === null);
  });

  test("renders content search results instead of the selected file", () => {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <FilesExplorerView
              sources={[source]}
              selectedPath={filePath}
              loadError={null}
              contentSearch={{
                query: "published",
                groups: [
                  {
                    rootPath: "/artifact",
                    rootTitle: "Published versions",
                    matches: [
                      {
                        path: filePath,
                        line: 1,
                        column: 3,
                        text: "Published",
                        contextBefore: [],
                        contextAfter: ["Install this version"],
                      },
                      {
                        path: filePath,
                        line: 4,
                        column: 2,
                        text: "published",
                        contextBefore: ["Already"],
                        contextAfter: [],
                      },
                    ],
                  },
                ],
              }}
              buildNodeTo={(path) => ({ pathname: "/files", search: `?path=${path}` })}
            />
          ),
        },
      ],
      { initialEntries: ["/files?q=published"] },
    );
    render(<RouterProvider router={router} />);

    screen.getByRole("searchbox", { name: "Search file contents" });
    screen.getByRole("navigation", { name: "File search results" });
    screen.getByText("1:3");
    screen.getByText("4:2");
    assert.equal(
      screen.getAllByRole("link").filter((link) => link.textContent?.includes(filePath)).length,
      1,
    );
    screen.getByRole("navigation", { name: "Files explorer" });
    assert(screen.queryByRole("heading", { name: "README.md" }) === null);
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
