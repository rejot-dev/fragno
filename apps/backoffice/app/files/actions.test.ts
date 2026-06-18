import { beforeEach, describe, expect, test, assert } from "vitest";

import {
  createMasterFileSystem,
  createSystemFilesContext,
  createUnsupportedFileSystem,
  performFilesAction,
  type FileContributor,
  type FileEntryDescriptor,
  type FilesContext,
} from "@/files";

const context: FilesContext = createSystemFilesContext({
  orgId: "org_123",
  backend: "backoffice",
});

const contributors: FileContributor[] = [];

const registerFileContributor = (contributor: FileContributor): void => {
  contributors.push(contributor);
};

const createTestMasterFileSystem = (): ReturnType<typeof createMasterFileSystem> =>
  createMasterFileSystem(context, { contributors });

beforeEach(() => {
  contributors.length = 0;
});

describe("files actions", () => {
  test("supports generic folder creation, text writes, and deletes through the master filesystem", async () => {
    const files = {
      "/project/README.md": "hello",
      "/project/src/index.ts": "export const value = 1;",
    } as Record<string, string>;

    registerFileContributor(createMutableMemoryContributor(files));
    const master = await createTestMasterFileSystem();

    const folderResult = await performFilesAction(master, {
      intent: "create-folder",
      path: "/project",
      folderName: "src/utils",
    });
    expect(folderResult).toMatchObject({
      ok: true,
      intent: "create-folder",
      path: "/project/src/utils/",
    });

    const writeResult = await performFilesAction(master, {
      intent: "write-text",
      path: "/project/README.md",
      content: "updated",
    });
    expect(writeResult).toMatchObject({
      ok: true,
      intent: "write-text",
      path: "/project/README.md",
    });
    assert(writeResult.detail?.textContent === "updated");
    assert(files["/project/README.md"] === "updated");

    const deleteResult = await performFilesAction(master, {
      intent: "delete",
      path: "/project/src/index.ts",
    });
    expect(deleteResult).toMatchObject({
      ok: true,
      intent: "delete",
      path: "/project/src/",
      detail: null,
    });
    expect(files["/project/src/index.ts"]).toBeUndefined();
  });

  test("rejects writes for read-only mounts", async () => {
    registerFileContributor({
      id: "readonly",
      kind: "static",
      mountPoint: "/readonly",
      title: "Read only",
      readOnly: true,
      persistence: "persistent",
      ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
      mkdir: async () => undefined,
      stat: async () => ({
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o555,
        size: 0,
        mtime: new Date(0),
      }),
      readdir: async () => [],
    });
    const master = await createTestMasterFileSystem();

    const result = await performFilesAction(master, {
      intent: "create-folder",
      path: "/readonly",
      folderName: "logs",
    });

    expect(result).toMatchObject({
      ok: false,
      intent: "create-folder",
      message: "/readonly is read-only and does not support create-folder.",
    });
  });

  test("surfaces unsupported operations when a mount omits them", async () => {
    registerFileContributor({
      id: "project",
      kind: "custom",
      mountPoint: "/project",
      title: "Project",
      readOnly: false,
      persistence: "session",
      ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
      stat: async () => ({
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: 5,
        mtime: new Date(0),
      }),
      readFile: async () => "hello",
    });
    const master = await createTestMasterFileSystem();

    await expect(
      performFilesAction(master, {
        intent: "write-text",
        path: "/project/README.md",
        content: "updated",
      }),
    ).rejects.toThrow(/write/);
  });
});

function createMutableMemoryContributor(files: Record<string, string>): FileContributor {
  const mountPoint = "/project";
  const folders = new Set<string>([`${mountPoint}/`, `${mountPoint}/src/`]);

  const buildTree = (currentMountPoint: string): FileEntryDescriptor[] => {
    const roots: FileEntryDescriptor[] = [];
    const folderMap = new Map<string, FileEntryDescriptor & { children: FileEntryDescriptor[] }>();

    const ensureFolder = (path: string) => {
      const folderPath = ensureFolderPath(path);
      const existing = folderMap.get(folderPath);
      if (existing) {
        return existing;
      }
      const folder: FileEntryDescriptor & { children: FileEntryDescriptor[] } = {
        kind: "folder",
        path: folderPath,
        title: folderPath.split("/").filter(Boolean).at(-1) ?? folderPath,
        children: [],
      };
      folderMap.set(folderPath, folder);
      const parent = getParentFolderPath(folderPath, currentMountPoint);
      if (!parent) {
        roots.push(folder);
      } else {
        ensureFolder(parent).children.push(folder);
      }
      return folder;
    };

    for (const folderPath of folders) {
      if (folderPath !== ensureFolderPath(currentMountPoint)) {
        ensureFolder(folderPath);
      }
    }

    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(`${currentMountPoint}/`)) {
        continue;
      }
      const parent = getParentFolderPath(path, currentMountPoint);
      const file: FileEntryDescriptor = {
        kind: "file",
        path,
        title: path.split("/").at(-1),
        sizeBytes: content.length,
        contentType: "text/plain",
      };
      if (!parent) {
        roots.push(file);
      } else {
        ensureFolder(parent).children.push(file);
      }
    }

    return roots.sort(sortEntries).map(sortEntryChildren);
  };

  const findEntry = (entries: FileEntryDescriptor[], path: string): FileEntryDescriptor | null => {
    for (const entry of entries) {
      if (
        entry.path === path ||
        (entry.kind === "folder" && entry.path === ensureFolderPath(path))
      ) {
        return entry;
      }
      if (entry.kind === "folder" && entry.children?.length) {
        const match = findEntry(entry.children, path);
        if (match) {
          return match;
        }
      }
    }
    return null;
  };

  return {
    id: "project",
    kind: "custom",
    mountPoint,
    title: "Project",
    readOnly: false,
    persistence: "session",
    ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
    getAllPaths: () => [mountPoint, ...folders, ...Object.keys(files)],
    readdir: async (path) => {
      const tree = buildTree(mountPoint);
      if (path === mountPoint || path === `${mountPoint}/`) {
        return tree.map((entry) => entry.path.split("/").filter(Boolean).at(-1) ?? entry.path);
      }
      const entry = findEntry(tree, path);
      return entry?.kind === "folder"
        ? (entry.children ?? []).map(
            (child) => child.path.split("/").filter(Boolean).at(-1) ?? child.path,
          )
        : [];
    },
    stat: async (path) => {
      const entry = findEntry(buildTree(mountPoint), path);
      if (!entry) {
        throw new Error("Path not found.");
      }
      return {
        isFile: entry.kind === "file",
        isDirectory: entry.kind === "folder",
        isSymbolicLink: false,
        mode: entry.kind === "folder" ? 0o755 : 0o644,
        size: entry.kind === "file" ? (entry.sizeBytes ?? 0) : 0,
        mtime: new Date(0),
      };
    },
    readFile: async (path) => files[path],
    writeFile: async (path, content) => {
      files[path] = typeof content === "string" ? content : new TextDecoder().decode(content);
    },
    mkdir: async (path) => {
      folders.add(ensureFolderPath(path));
    },
    rm: async (path) => {
      if (path.endsWith("/")) {
        folders.delete(ensureFolderPath(path));
        for (const key of Object.keys(files)) {
          if (key.startsWith(path)) {
            delete files[key];
          }
        }
        return;
      }
      delete files[path];
    },
  };
}

function sortEntryChildren(entry: FileEntryDescriptor): FileEntryDescriptor {
  return {
    ...entry,
    children: entry.children?.slice().sort(sortEntries).map(sortEntryChildren),
  };
}

function sortEntries(left: FileEntryDescriptor, right: FileEntryDescriptor) {
  const leftOrder = left.kind === "folder" ? 0 : 1;
  const rightOrder = right.kind === "folder" ? 0 : 1;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return (left.title ?? left.path).localeCompare(right.title ?? right.path);
}

function getParentFolderPath(path: string, mountPoint: string): string | null {
  const normalized = path.replace(/\/+$/, "");
  if (normalized === mountPoint) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return null;
  }

  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent === mountPoint ? null : ensureFolderPath(parent);
}

function ensureFolderPath(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
