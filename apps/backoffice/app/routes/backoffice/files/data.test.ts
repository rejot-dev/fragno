import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";

const { createFilesOverviewCollectionsMock, fetchUploadAdapterIdentityMock } = vi.hoisted(() => ({
  createFilesOverviewCollectionsMock: vi.fn(),
  fetchUploadAdapterIdentityMock: vi.fn(),
}));

vi.mock("./file-collections.server", () => ({
  createFilesOverviewCollections: createFilesOverviewCollectionsMock,
}));

vi.mock("@/fragno/upload/tanstack/server", () => ({
  fetchUploadAdapterIdentity: fetchUploadAdapterIdentityMock,
}));

import { loadFilesExplorerData } from "./data";

const mockContext = { get: () => ({ runtime: { objects: {}, config: {} } }) } as never;

beforeEach(() => {
  createFilesOverviewCollectionsMock.mockReset();
  fetchUploadAdapterIdentityMock.mockReset();
  fetchUploadAdapterIdentityMock.mockResolvedValue("adapter-1");
  createFilesOverviewCollectionsMock.mockResolvedValue([
    {
      rootPath: "/static",
      rootTitle: "Static",
      rootKind: "static",
      readOnly: true,
      persistence: "persistent",
      collection: createStaticFileCollection({ "SYSTEM.md": "Static guidance" }),
    },
    {
      rootPath: "/system",
      rootTitle: "System",
      rootKind: "static",
      readOnly: true,
      persistence: "persistent",
      collection: createStaticFileCollection({ "README.md": "System files" }),
    },
    {
      rootPath: "/workspace",
      rootTitle: "Workspace",
      rootKind: "upload",
      readOnly: false,
      persistence: "persistent",
      collection: createStaticFileCollection({
        "automations/example.workflow.js": "export default {};",
      }),
      clientSynchronization: { kind: "upload", provider: "database" },
    },
  ]);
});

describe("files explorer route data", () => {
  test("returns FileTree sources from registered collections", async () => {
    const result = await loadFilesExplorerData({
      request: new Request(
        "https://backoffice.test/files/acme-org/workspace/automations/example.workflow.js",
      ),
      context: mockContext,
      orgId: "acme-org",
      requestedPath: "/workspace/automations/example.workflow.js",
    });

    expect(result.sources.map((source) => source.rootPath)).toEqual([
      "/workspace",
      "/static",
      "/system",
    ]);
    expect(
      result.sources.find((source) => source.rootPath === "/workspace")?.synchronization,
    ).toEqual({
      kind: "upload",
      provider: "database",
      source: { orgId: "acme-org", adapterIdentity: "adapter-1" },
    });
    assert(result.selectedPath === "/workspace/automations/example.workflow.js");
    expect(result.selectedContent).toEqual({
      path: "/workspace/automations/example.workflow.js",
      text: "export default {};",
    });
    assert(result.loadError === null);
  });

  test("retains paths that may exist optimistically in a synchronized collection", async () => {
    const result = await loadFilesExplorerData({
      request: new Request(
        "https://backoffice.test/files/acme-org/workspace/new-optimistic-file.txt",
      ),
      context: mockContext,
      orgId: "acme-org",
      requestedPath: "/workspace/new-optimistic-file.txt",
    });

    assert(result.selectedPath === "/workspace/new-optimistic-file.txt");
    assert(result.selectedContent === null);
    assert(result.loadError === null);
  });

  test("falls back to the first collection for an unknown path", async () => {
    const result = await loadFilesExplorerData({
      request: new Request("https://backoffice.test/files/acme-org/missing"),
      context: mockContext,
      orgId: "acme-org",
      requestedPath: "/missing",
    });

    assert(result.selectedPath === "/workspace");
    assert(result.selectedContent === null);
    assert(result.loadError === "Path '/missing' could not be found.");
  });

  test("does not retrieve text content that exceeds the preview limit", async () => {
    const getFile = vi.fn();
    createFilesOverviewCollectionsMock.mockResolvedValue([
      {
        rootPath: "/workspace",
        rootTitle: "Workspace",
        collection: {
          async getTree() {
            return {
              entries: [
                {
                  kind: "file" as const,
                  path: "large.txt",
                  sizeBytes: 1024 * 1024 + 1,
                  contentType: "text/plain",
                  updatedAt: null,
                  metadata: null,
                },
              ],
            };
          },
          getFile,
        },
      },
    ]);

    const result = await loadFilesExplorerData({
      request: new Request("https://backoffice.test/files/acme-org/workspace/large.txt"),
      context: mockContext,
      orgId: "acme-org",
      requestedPath: "/workspace/large.txt",
    });

    assert(result.selectedContent === null);
    expect(getFile).not.toHaveBeenCalled();
  });

  test("keeps available collections when another tree fails to load", async () => {
    createFilesOverviewCollectionsMock.mockResolvedValue([
      {
        rootPath: "/static",
        rootTitle: "Static",
        collection: createStaticFileCollection({ "SYSTEM.md": "Static guidance" }),
      },
      {
        rootPath: "/workspace",
        rootTitle: "Workspace",
        collection: {
          async getTree() {
            throw new Error("Upload file tree exceeded its 1-page retrieval limit.");
          },
          async getFile() {
            return null;
          },
        },
      },
    ]);

    const result = await loadFilesExplorerData({
      request: new Request("https://backoffice.test/files"),
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result.sources.map((source) => source.rootPath)).toEqual(["/static"]);
    assert(
      result.loadError ===
        "Workspace could not be loaded: Upload file tree exceeded its 1-page retrieval limit.",
    );
  });
});
