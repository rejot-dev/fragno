import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryFs } from "just-bash";

import type { FileContent, FsStat } from "./interface";
import { createMasterFileSystem } from "./master-file-system";
import { isMountPointParentOf, normalizeMountPoint, normalizeRelativePath } from "./normalize-path";
import { registerFileContributor, resetFileContributorsForTest } from "./registry";
import type { FileContributor, FilesContext, MountedFileSystem } from "./types";

const context = {
  orgId: "org_123",
  backend: "backoffice" as const,
} satisfies FilesContext;

const DIRECTORY_STAT: FsStat = {
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: 0o755,
  size: 0,
  mtime: new Date(0),
};

beforeEach(() => {
  resetFileContributorsForTest();
});

describe("createMasterFileSystem", () => {
  test("auto-registers built-ins and keeps deterministic display order", async () => {
    registerFileContributor(makeContributor("docs", "/docs"));
    registerFileContributor(makeContributor("examples", "/examples"));

    const resolved = await createMasterFileSystem(context);

    expect(resolved.mounts.map((mount) => mount.mountPoint)).toEqual([
      "/system",
      "/workspace",
      "/docs",
      "/examples",
    ]);
  });

  test("trims org ids and rejects missing org ids", async () => {
    await expect(createMasterFileSystem({ ...context, orgId: "   " })).rejects.toThrow(
      /Missing organisation id in file system context/,
    );

    const resolved = await createMasterFileSystem({ ...context, orgId: "  org_123  " });
    expect(resolved.mounts.map((mount) => mount.mountPoint)).toEqual(["/system", "/workspace"]);
  });

  test("rejects duplicate mount points", async () => {
    registerFileContributor(makeContributor("a", "/custom"));
    registerFileContributor(makeContributor("b", "/custom"));

    await expect(createMasterFileSystem(context)).rejects.toThrow(/Duplicate file mount point/);
  });

  test("uses longest-prefix routing for nested mounts and synthesizes parent directories", async () => {
    registerFileContributor({
      ...makeContributor("archive", "/system/archive"),
      stat: async (path) => {
        if (path === "/system/archive" || path === "/system/archive/file.txt") {
          return {
            isFile: path.endsWith("file.txt"),
            isDirectory: !path.endsWith("file.txt"),
            isSymbolicLink: false,
            mode: path.endsWith("file.txt") ? 0o644 : 0o755,
            size: path.endsWith("file.txt") ? 4 : 0,
            mtime: new Date(0),
          } satisfies FsStat;
        }

        throw new Error("Path not found.");
      },
      readdir: async (path) => (path === "/system/archive" ? ["file.txt"] : []),
      readFile: async () => "test",
      getAllPaths: () => ["/system/archive", "/system/archive/file.txt"],
    });

    const master = await createMasterFileSystem(context);

    expect(master.getMountForPath("/system/archive/file.txt")?.id).toBe("archive");
    expect(master.getMountForPath("/outside")).toBeNull();
    await expect(master.stat("/")).resolves.toMatchObject({ isDirectory: true });
    await expect(master.stat("/system")).resolves.toMatchObject({ isDirectory: true });
    await expect(master.stat("/system/archive")).resolves.toMatchObject({ isDirectory: true });
    await expect(master.readFile("/system/archive/file.txt")).resolves.toBe("test");
    await expect(master.readdir("/")).resolves.toEqual(
      expect.arrayContaining(["system", "workspace"]),
    );
    await expect(master.readdir("/system")).resolves.toEqual(expect.arrayContaining(["archive"]));
    expect(master.getAllPaths()).toEqual(
      expect.arrayContaining(["/", "/system", "/system/archive", "/system/archive/file.txt"]),
    );
  });

  test("synthesizes writable and read-only virtual parent directories for nested mounts", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
      directories: ["/project/docs"],
      files: {
        "/project/docs/readme.md": "hello",
      },
    });

    registerFileContributor(projectContributor);
    registerFileContributor(makeContributor("generated", "/project/generated/deep"));
    registerFileContributor(makeContributor("systemArchive", "/system/archive/deep"));

    const master = await createMasterFileSystem(context);

    await expect(master.stat("/project/generated")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o755,
    });
    await expect(master.stat("/system/archive")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o555,
    });
  });

  test("merges mounted directory entries with synthetic child directories", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
      directories: ["/project/docs"],
      files: {
        "/project/docs/readme.md": "hello",
      },
    });

    registerFileContributor(projectContributor);
    registerFileContributor(makeContributor("generated", "/project/generated/deep"));

    const master = await createMasterFileSystem(context);
    const entries = await master.readdirWithFileTypes("/project");

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "docs", isDirectory: true }),
        expect.objectContaining({ name: "generated", isDirectory: true }),
      ]),
    );
  });

  test("falls back between text and binary read methods", async () => {
    const { contributor: binaryContributor } = await createInMemoryContributor({
      id: "binary",
      mountPoint: "/binary",
      files: {
        "/binary/data.txt": new TextEncoder().encode("hello"),
      },
      includeReadFile: false,
    });
    const { contributor: textContributor } = await createInMemoryContributor({
      id: "notes",
      mountPoint: "/notes",
      files: {
        "/notes/todo.md": "ship it",
      },
      includeReadFileBuffer: false,
    });

    registerFileContributor(binaryContributor);
    registerFileContributor(textContributor);

    const master = await createMasterFileSystem(context);

    await expect(master.readFile("/binary/data.txt")).resolves.toBe("hello");
    await expect(master.readFileBuffer("/notes/todo.md")).resolves.toEqual(
      new TextEncoder().encode("ship it"),
    );
  });

  test("delegates read streams and surfaces unsupported stream mounts", async () => {
    const { contributor: textContributor } = await createInMemoryContributor({
      id: "notes",
      mountPoint: "/notes",
      files: {
        "/notes/todo.md": "ship it",
      },
    });

    registerFileContributor(
      makeContributor("streams", "/streams", {
        stat: async (path) => {
          if (path === "/streams") {
            return DIRECTORY_STAT;
          }
          if (path === "/streams/big.bin") {
            return {
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
              mode: 0o644,
              size: 9,
              mtime: new Date(0),
            } satisfies FsStat;
          }

          throw new Error("Path not found.");
        },
        readdir: async (path) => (path === "/streams" ? ["big.bin"] : []),
        readFileStream: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("stream me"));
              controller.close();
            },
          }),
        getAllPaths: () => ["/streams", "/streams/big.bin"],
      }),
    );
    registerFileContributor(textContributor);

    const master = await createMasterFileSystem(context);

    await expect(readStream(await master.readFileStream("/streams/big.bin"))).resolves.toBe(
      "stream me",
    );
    await expect(master.readFileStream("/notes/todo.md")).rejects.toMatchObject({
      code: "ENOTSUP",
    });
  });

  test("appends, copies, and moves files within the same writable mount", async () => {
    const { contributor: projectContributor, fs } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
      directories: ["/project/src", "/project/src/nested"],
      files: {
        "/project/README.md": "hello",
        "/project/notes.txt": "",
        "/project/src/index.ts": "export const value = 1;",
        "/project/src/nested/child.txt": "child",
      },
    });

    registerFileContributor(projectContributor);

    const master = await createMasterFileSystem(context);

    await master.appendFile("/project/README.md", " world");
    await master.appendFile("/project/notes.txt", "fresh");
    await master.cp("/project/src", "/project/copy", { recursive: true });
    await master.mv("/project/copy", "/project/moved");

    await expect(master.readFile("/project/README.md")).resolves.toBe("hello world");
    await expect(master.readFile("/project/notes.txt")).resolves.toBe("fresh");
    await expect(master.readFile("/project/moved/index.ts")).resolves.toBe(
      "export const value = 1;",
    );
    await expect(master.readFile("/project/moved/nested/child.txt")).resolves.toBe("child");
    await expect(master.readFile("/project/copy/index.ts")).rejects.toThrow();
    await expect(fs.readFile("/project/moved/index.ts")).resolves.toBe("export const value = 1;");
  });

  test("rejects cross-mount copy and move", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
      files: {
        "/project/README.md": "hello",
      },
    });

    registerFileContributor(projectContributor);

    const master = await createMasterFileSystem(context);

    await expect(master.cp("/system/README.md", "/project/README.md")).rejects.toThrow(
      /Cross-mount copy/,
    );
    await expect(master.mv("/system/README.md", "/project/README.md")).rejects.toThrow(
      /Cross-mount move/,
    );
  });

  test("treats recursive mkdir on existing paths as a no-op when mounts omit mkdir", async () => {
    registerFileContributor(
      makeContributor("project", "/project", {
        readOnly: false,
        persistence: "session",
        stat: async (path) => {
          if (path === "/project" || path === "/project/existing") {
            return DIRECTORY_STAT;
          }
          throw new Error("Path not found.");
        },
        readdir: async (path) => {
          if (path === "/project") {
            return ["existing"];
          }
          return [];
        },
      }),
    );

    const master = await createMasterFileSystem(context);

    await expect(master.mkdir("/project/existing", { recursive: true })).resolves.toBeUndefined();
    await expect(master.mkdir("/project/new-folder")).rejects.toThrow(
      /does not support creating directories/,
    );
  });

  test("rejects writes to virtual-only directories created by mount routing", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
    });

    registerFileContributor(projectContributor);
    registerFileContributor(makeContributor("generated", "/project/generated/deep"));

    const master = await createMasterFileSystem(context);

    await expect(master.mkdir("/project/generated")).rejects.toThrow(
      /virtual directory created by mount routing/,
    );
    await expect(master.writeFile("/project/generated", "nope")).rejects.toThrow(
      /virtual directory created by mount routing/,
    );
  });

  test("delegates chmod, symlink, link, readlink, realpath, and utimes when supported", async () => {
    const calls = [] as string[];

    registerFileContributor(
      makeContributor("ops", "/ops", {
        readOnly: false,
        persistence: "session",
        stat: async (path) => {
          if (path === "/ops") {
            return DIRECTORY_STAT;
          }
          if (path === "/ops/file.txt") {
            return {
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
              mode: 0o644,
              size: 4,
              mtime: new Date(0),
            } satisfies FsStat;
          }
          if (path === "/ops/link.txt") {
            return {
              isFile: false,
              isDirectory: false,
              isSymbolicLink: true,
              mode: 0o777,
              size: 0,
              mtime: new Date(0),
            } satisfies FsStat;
          }
          throw new Error("Path not found.");
        },
        readdir: async () => ["file.txt", "link.txt"],
        chmod: async (path, mode) => {
          calls.push(`chmod:${path}:${mode.toString(8)}`);
        },
        symlink: async (target, linkPath) => {
          calls.push(`symlink:${target}:${linkPath}`);
        },
        link: async (existingPath, newPath) => {
          calls.push(`link:${existingPath}:${newPath}`);
        },
        readlink: async (path) => {
          calls.push(`readlink:${path}`);
          return "/ops/file.txt";
        },
        realpath: async (path) => {
          calls.push(`realpath:${path}`);
          return `/real${path}`;
        },
        utimes: async (path) => {
          calls.push(`utimes:${path}`);
        },
      }),
    );

    const master = await createMasterFileSystem(context);

    await master.chmod("/ops/file.txt", 0o600);
    await master.symlink("/ops/file.txt", "/ops/link.txt");
    await master.link("/ops/file.txt", "/ops/file-copy.txt");
    await expect(master.readlink("/ops/link.txt")).resolves.toBe("/ops/file.txt");
    await expect(master.realpath("/ops/file.txt")).resolves.toBe("/real/ops/file.txt");
    await master.utimes("/ops/file.txt", new Date(0), new Date(0));

    expect(calls).toEqual([
      "chmod:/ops/file.txt:600",
      "symlink:/ops/file.txt:/ops/link.txt",
      "link:/ops/file.txt:/ops/file-copy.txt",
      "readlink:/ops/link.txt",
      "realpath:/ops/file.txt",
      "utimes:/ops/file.txt",
    ]);
  });

  test("normalizes synthetic and mounted realpaths when a mount does not provide realpath", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
      files: {
        "/project/README.md": "hello",
      },
      includeRealpath: false,
    });

    registerFileContributor(projectContributor);
    registerFileContributor(makeContributor("generated", "/project/generated/deep"));

    const master = await createMasterFileSystem(context);

    await expect(master.realpath("/project/generated/")).resolves.toBe("/project/generated");
    await expect(master.realpath("/project/README.md")).resolves.toBe("/project/README.md");
  });

  test("validates mount point and relative-path normalization", () => {
    expect(normalizeMountPoint("//workspace//")).toBe("/workspace");
    expect(normalizeRelativePath("  folder/sub/ ")).toBe("folder/sub");
    expect(normalizeRelativePath("/")).toBe("");
  });

  test("detects parent mount relationship", () => {
    expect(isMountPointParentOf("/system", "/system/archive")).toBe(true);
    expect(isMountPointParentOf("/system", "/systematic")).toBe(false);
  });
});

const MOUNT_TEMPLATE = {
  kind: "custom" as const,
  title: "Root",
  readOnly: true,
  persistence: "persistent" as const,
  stat: async () => DIRECTORY_STAT,
  readdir: async () => [],
};

function makeContributor(
  id: string,
  mountPoint: string,
  overrides: Partial<FileContributor> = {},
): FileContributor {
  return {
    id,
    mountPoint,
    ...MOUNT_TEMPLATE,
    ...overrides,
  };
}

type InMemoryContributorOptions = {
  id: string;
  mountPoint: string;
  kind?: FileContributor["kind"];
  title?: string;
  readOnly?: boolean;
  persistence?: FileContributor["persistence"];
  directories?: string[];
  files?: Record<string, FileContent>;
  includeReadFile?: boolean;
  includeReadFileBuffer?: boolean;
  includeWriteFile?: boolean;
  includeMkdir?: boolean;
  includeRm?: boolean;
  includeRealpath?: boolean;
};

async function createInMemoryContributor(options: InMemoryContributorOptions) {
  const fs = new InMemoryFs();
  const knownPaths = new Set<string>();
  const mountPoint = normalizeAbsolutePath(options.mountPoint);

  const recordPath = (path: string) => {
    const normalizedPath = normalizeAbsolutePath(path);
    const segments = normalizedPath.split("/").filter(Boolean);

    for (let index = 1; index <= segments.length; index += 1) {
      knownPaths.add(`/${segments.slice(0, index).join("/")}`);
    }
  };

  const removePath = (path: string) => {
    const normalizedPath = normalizeAbsolutePath(path);
    for (const knownPath of Array.from(knownPaths)) {
      if (knownPath === normalizedPath || knownPath.startsWith(`${normalizedPath}/`)) {
        knownPaths.delete(knownPath);
      }
    }
  };

  await fs.mkdir(mountPoint, { recursive: true });
  recordPath(mountPoint);

  for (const directory of options.directories ?? []) {
    await fs.mkdir(directory, { recursive: true });
    recordPath(directory);
  }

  for (const [path, content] of Object.entries(options.files ?? {})) {
    await fs.mkdir(parentPath(path), { recursive: true });
    await fs.writeFile(path, content);
    recordPath(path);
  }

  const contributor: FileContributor = {
    id: options.id,
    kind: options.kind ?? "custom",
    mountPoint,
    title: options.title ?? options.id,
    readOnly: options.readOnly ?? false,
    persistence: options.persistence ?? "session",
    stat: fs.stat.bind(fs),
    readdir: fs.readdir.bind(fs),
    ...(typeof (fs as unknown as MountedFileSystem).readdirWithFileTypes === "function"
      ? {
          readdirWithFileTypes: (fs as unknown as MountedFileSystem).readdirWithFileTypes.bind(fs),
        }
      : {}),
    ...(options.includeReadFile === false ? {} : { readFile: fs.readFile.bind(fs) }),
    ...(options.includeReadFileBuffer === false
      ? {}
      : { readFileBuffer: fs.readFileBuffer.bind(fs) }),
    ...(options.includeWriteFile === false
      ? {}
      : {
          writeFile: async (path, content, writeOptions) => {
            await fs.writeFile(path, content, writeOptions);
            recordPath(path);
          },
        }),
    ...(options.includeMkdir === false
      ? {}
      : {
          mkdir: async (path, mkdirOptions) => {
            await fs.mkdir(path, mkdirOptions);
            recordPath(path);
          },
        }),
    ...(options.includeRm === false
      ? {}
      : {
          rm: async (path, rmOptions) => {
            await fs.rm(path, rmOptions);
            removePath(path);
          },
        }),
    ...(options.includeRealpath === false ||
    typeof (fs as unknown as MountedFileSystem).realpath !== "function"
      ? {}
      : { realpath: (fs as unknown as MountedFileSystem).realpath.bind(fs) }),
    getAllPaths: () => Array.from(knownPaths).sort(),
  };

  return { contributor, fs };
}

function normalizeAbsolutePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function parentPath(path: string): string {
  const normalizedPath = normalizeAbsolutePath(path);
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "/";
  }
  return `/${segments.slice(0, -1).join("/")}`;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
}
