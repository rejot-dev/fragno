import { beforeEach, describe, expect, test, vi } from "vitest";

const { createOrgFileSystemMock } = vi.hoisted(() => ({
  createOrgFileSystemMock: vi.fn(),
}));

vi.mock("@/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/files")>();
  return {
    ...actual,
    createOrgFileSystem: createOrgFileSystemMock,
  };
});

import {
  createMasterFileSystem,
  registerFileContributor,
  resetFileContributorsForTest,
  type FileContributor,
  type FileEntryDescriptor,
} from "@/files";

import { handleFilesExplorerAction, loadFilesExplorerData } from "./data";

const mockContext = { get: () => ({ env: {} }) } as never;

beforeEach(() => {
  resetFileContributorsForTest();
  createOrgFileSystemMock.mockReset();
  createOrgFileSystemMock.mockImplementation(() =>
    createMasterFileSystem({ orgId: "acme-org", uploadConfig: null }),
  );
});

describe("files explorer route data", () => {
  test("falls back to the first mount when the requested path cannot be found", async () => {
    const result = await loadFilesExplorerData({
      request: new Request("https://docs.example.test/backoffice/files?path=/missing"),
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result.tree.map((root) => root.path)).toEqual(["/system", "/workspace"]);
    expect(result.selectedPath).toBe("/system");
    expect(result.selectedDetail?.node.path).toBe("/system");
    expect(result.loadError).toBe("Path '/missing' could not be found.");
  });

  test("rejects unknown action intents before dispatching to the files domain", async () => {
    const formData = new FormData();
    formData.set("intent", "rename");
    formData.set("path", "/system");

    const result = await handleFilesExplorerAction({
      request: new Request("https://docs.example.test/backoffice/files", {
        method: "POST",
        body: formData,
      }),
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result).toEqual({
      ok: false,
      intent: "rename",
      message: "Unknown file action.",
    });
  });

  test("dispatches valid actions through the shared master filesystem", async () => {
    const { contributor, folders } = createMutableProjectContributor();
    registerFileContributor(contributor);

    const formData = new FormData();
    formData.set("intent", "create-folder");
    formData.set("path", "/project");
    formData.set("folderName", "notes/archive");

    const result = await handleFilesExplorerAction({
      request: new Request("https://docs.example.test/backoffice/files", {
        method: "POST",
        body: formData,
      }),
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result).toMatchObject({
      ok: true,
      intent: "create-folder",
      path: "/project/notes/archive/",
      detail: {
        node: {
          kind: "folder",
          path: "/project/notes/archive/",
        },
      },
    });
    expect(folders.has("/project/notes")).toBe(true);
    expect(folders.has("/project/notes/archive")).toBe(true);
  });

  test("expands the selected folder branch by querying the filesystem for its children", async () => {
    const { contributor } = createMutableProjectContributor({
      files: [["/project/hello/world/task.md", "deep file"]],
      folders: ["/project", "/project/hello", "/project/hello/world"],
    });
    registerFileContributor(contributor);

    const result = await loadFilesExplorerData({
      request: new Request("https://docs.example.test/backoffice/files?path=/project/hello/world/"),
      context: mockContext,
      orgId: "acme-org",
    });

    const projectRoot = result.tree.find((node) => node.path === "/project");
    const helloFolder = projectRoot?.children?.find((node) => node.path === "/project/hello/");
    const worldFolder = helloFolder?.children?.find(
      (node) => node.path === "/project/hello/world/",
    );

    expect(projectRoot?.children?.map((node) => node.path)).toContain("/project/hello/");
    expect(helloFolder?.children?.map((node) => node.path)).toContain("/project/hello/world/");
    expect(worldFolder?.children?.map((node) => node.path)).toContain(
      "/project/hello/world/task.md",
    );
    expect(result.selectedPath).toBe("/project/hello/world/");
    expect(result.selectedDetail?.node.path).toBe("/project/hello/world/");
  });

  test("preserves eagerly described nested children in the initial tree", async () => {
    const { contributor } = createMutableProjectContributor({
      files: [
        ["/project/hello/world/task.md", "deep file"],
        ["/project/input/notes.md", "notes"],
        ["/project/output/.gitkeep", ""],
      ],
      folders: [
        "/project",
        "/project/hello",
        "/project/hello/world",
        "/project/input",
        "/project/output",
      ],
      describedChildren: {
        "/project/input/": [{ kind: "file", path: "/project/input/notes.md", title: "notes.md" }],
        "/project/output/": [{ kind: "file", path: "/project/output/.gitkeep", title: ".gitkeep" }],
      },
    });
    registerFileContributor(contributor);

    const initial = await loadFilesExplorerData({
      request: new Request("https://docs.example.test/backoffice/files?path=/project"),
      context: mockContext,
      orgId: "acme-org",
    });
    const initialProjectRoot = initial.tree.find((node) => node.path === "/project");
    const helloFolder = initialProjectRoot?.children?.find(
      (node) => node.path === "/project/hello/",
    );
    const inputFolder = initialProjectRoot?.children?.find(
      (node) => node.path === "/project/input/",
    );
    const outputFolder = initialProjectRoot?.children?.find(
      (node) => node.path === "/project/output/",
    );

    expect(initialProjectRoot?.children?.map((node) => node.path)).toEqual([
      "/project/hello/",
      "/project/input/",
      "/project/output/",
    ]);
    expect(helloFolder?.children).toBeUndefined();
    expect(inputFolder?.children?.map((node) => node.path)).toEqual(["/project/input/notes.md"]);
    expect(outputFolder?.children?.map((node) => node.path)).toEqual(["/project/output/.gitkeep"]);
  });

  test("expands the selected folder branch while preserving eager sibling children", async () => {
    const { contributor } = createMutableProjectContributor({
      files: [
        ["/project/hello/world/task.md", "deep file"],
        ["/project/input/notes.md", "notes"],
        ["/project/output/.gitkeep", ""],
      ],
      folders: [
        "/project",
        "/project/hello",
        "/project/hello/world",
        "/project/input",
        "/project/output",
      ],
      describedChildren: {
        "/project/input/": [{ kind: "file", path: "/project/input/notes.md", title: "notes.md" }],
        "/project/output/": [{ kind: "file", path: "/project/output/.gitkeep", title: ".gitkeep" }],
      },
    });
    registerFileContributor(contributor);

    const expanded = await loadFilesExplorerData({
      request: new Request("https://docs.example.test/backoffice/files?path=/project/hello/"),
      context: mockContext,
      orgId: "acme-org",
    });
    const expandedProjectRoot = expanded.tree.find((node) => node.path === "/project");
    const helloFolder = expandedProjectRoot?.children?.find(
      (node) => node.path === "/project/hello/",
    );
    const inputFolder = expandedProjectRoot?.children?.find(
      (node) => node.path === "/project/input/",
    );
    const outputFolder = expandedProjectRoot?.children?.find(
      (node) => node.path === "/project/output/",
    );

    expect(helloFolder?.children?.map((node) => node.path)).toEqual(["/project/hello/world/"]);
    expect(inputFolder?.children?.map((node) => node.path)).toEqual(["/project/input/notes.md"]);
    expect(outputFolder?.children?.map((node) => node.path)).toEqual(["/project/output/.gitkeep"]);
  });
});

function createMutableProjectContributor(options?: {
  files?: Array<[path: string, content: string]>;
  folders?: string[];
  describedChildren?: Record<string, FileEntryDescriptor[]>;
}): {
  contributor: FileContributor;
  folders: Set<string>;
} {
  const files = new Map<string, string>(options?.files ?? [["/project/README.md", "hello"]]);
  const folders = new Set<string>(options?.folders ?? ["/project", "/project/src"]);
  const describedChildren = new Map(
    Object.entries(options?.describedChildren ?? {}).map(([path, children]) => [
      ensureFolderPath(path),
      children,
    ]),
  );

  const contributor: FileContributor = {
    id: "project",
    kind: "custom",
    mountPoint: "/project",
    title: "Project",
    readOnly: false,
    persistence: "session",
    async exists(path) {
      return files.has(path) || folders.has(normalizeDirectory(path));
    },
    async stat(path) {
      const normalizedDirectory = normalizeDirectory(path);
      if (files.has(path)) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o644,
          size: files.get(path)?.length ?? 0,
          mtime: new Date(0),
        };
      }

      if (folders.has(normalizedDirectory)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(0),
        };
      }

      throw new Error("Path not found.");
    },
    async describeEntry(path) {
      const normalizedDirectory = normalizeDirectory(path);
      if (files.has(path)) {
        return {
          kind: "file",
          path,
          title: path.split("/").at(-1) ?? path,
          sizeBytes: files.get(path)?.length ?? 0,
          contentType: "text/plain",
        };
      }

      if (folders.has(normalizedDirectory)) {
        return {
          kind: "folder",
          path: ensureFolderPath(path),
          title: normalizedDirectory.split("/").at(-1) ?? normalizedDirectory,
          children: describedChildren.get(ensureFolderPath(path)),
        };
      }

      return null;
    },
    async readdir(path) {
      const directory = normalizeDirectory(path);
      const names = new Set<string>();

      for (const folder of folders) {
        if (!folder.startsWith(`${directory}/`)) {
          continue;
        }

        const relative = folder.slice(directory.length + 1);
        if (relative && !relative.includes("/")) {
          names.add(relative);
        }
      }

      for (const filePath of files.keys()) {
        if (!filePath.startsWith(`${directory}/`)) {
          continue;
        }

        const relative = filePath.slice(directory.length + 1);
        if (relative && !relative.includes("/")) {
          names.add(relative);
        }
      }

      return Array.from(names).sort();
    },
    async readFile(path) {
      const file = files.get(path);
      if (file === undefined) {
        throw new Error("File not found.");
      }
      return file;
    },
    async writeFile(path, content) {
      files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
    },
    async mkdir(path, options) {
      const segments = normalizeDirectory(path).split("/").filter(Boolean);
      if (!options?.recursive) {
        folders.add(`/${segments.join("/")}`);
        return;
      }

      for (let index = 1; index <= segments.length; index += 1) {
        folders.add(`/${segments.slice(0, index).join("/")}`);
      }
    },
    async rm(path, options) {
      if (files.delete(path)) {
        return;
      }

      const directory = normalizeDirectory(path);
      if (!options?.recursive) {
        throw new Error("recursive required");
      }

      folders.delete(directory);
      for (const existingFolder of Array.from(folders)) {
        if (existingFolder.startsWith(`${directory}/`)) {
          folders.delete(existingFolder);
        }
      }
      for (const filePath of Array.from(files.keys())) {
        if (filePath.startsWith(`${directory}/`)) {
          files.delete(filePath);
        }
      }
    },
  };

  return { contributor, folders };
}

const normalizeDirectory = (path: string) => path.replace(/\/+$/, "") || "/";
const ensureFolderPath = (path: string) => (path.endsWith("/") ? path : `${path}/`);
