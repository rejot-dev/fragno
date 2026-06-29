import { beforeEach, describe, expect, test, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";

import { getBuiltInFileContributors } from "./contributors";
import { createReadOnlyFileSystemError } from "./fs-errors";
import { createUnsupportedFileSystem, type FileContent, type FsStat } from "./interface";
import { createMasterFileSystem, MasterFileSystem } from "./master-file-system";
import { isMountPointParentOf, normalizeMountPoint, normalizeRelativePath } from "./normalize-path";
import { createSystemFilesContext } from "./system-context";
import type { FileContributor, FilesContext } from "./types";

const context = createSystemFilesContext({
  execution: {
    actor: { type: "system", id: "system" },
    scope: { kind: "org", orgId: "org_123" },
  },
  backend: "backoffice",
}) satisfies FilesContext;

const DIRECTORY_STAT: FsStat = {
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: 0o755,
  size: 0,
  mtime: new Date(0),
};

const extraContributors: FileContributor[] = [];

const registerFileContributor = (contributor: FileContributor): void => {
  extraContributors.push(contributor);
};

const createTestMasterFileSystem = (ctx: FilesContext = context): Promise<MasterFileSystem> =>
  createMasterFileSystem(ctx, {
    contributors: [...getBuiltInFileContributors(), ...extraContributors],
  });

beforeEach(() => {
  extraContributors.length = 0;
});

describe("createMasterFileSystem", () => {
  test("uses explicit contributors without implicit built-ins", async () => {
    const resolved = await createMasterFileSystem(context, {
      contributors: [makeContributor("project", "/project")],
    });

    expect(resolved.mounts.map((mount) => mount.mountPoint)).toEqual(["/project"]);
  });

  test("uses built-ins by default and keeps deterministic display order", async () => {
    registerFileContributor(makeContributor("docs", "/docs"));
    registerFileContributor(makeContributor("examples", "/examples"));

    const resolved = await createTestMasterFileSystem();

    expect(resolved.mounts.map((mount) => mount.mountPoint)).toEqual([
      "/system",
      "/docs",
      "/examples",
      "/tmp",
    ]);
  });

  test("supports system execution scope for non-object-backed mounts", async () => {
    const resolved = await createTestMasterFileSystem({
      ...context,
      execution: { actor: { type: "system", id: "system" }, scope: { kind: "system" } },
    });

    expect(resolved.mounts.map((mount) => mount.mountPoint)).toEqual(["/system", "/tmp"]);
  });

  test("rejects duplicate mount points", async () => {
    registerFileContributor(makeContributor("a", "/custom"));
    registerFileContributor(makeContributor("b", "/custom"));

    await expect(createTestMasterFileSystem()).rejects.toThrow(/Duplicate file mount point/);
  });

  test("rejects nested mount points instead of longest-prefix routing", async () => {
    registerFileContributor(makeContributor("archive", "/system/archive"));

    await expect(createTestMasterFileSystem()).rejects.toThrow(
      /Overlapping file mount points are not supported: '\/system' and '\/system\/archive'/,
    );
  });

  test("synthesizes virtual parent directories for deep standalone mounts", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
      directories: ["/project/docs"],
      files: {
        "/project/docs/readme.md": "hello",
      },
    });

    registerFileContributor(projectContributor);
    registerFileContributor(makeContributor("generated", "/generated/deep"));

    const master = await createTestMasterFileSystem();

    await expect(master.stat("/generated")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o755,
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
    registerFileContributor(makeContributor("generated", "/generated/deep"));

    const master = await createTestMasterFileSystem();
    const rootEntries = await master.readdirWithFileTypes("/");
    const projectEntries = await master.readdirWithFileTypes("/project");

    expect(rootEntries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "generated", isDirectory: true })]),
    );
    expect(projectEntries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "docs", isDirectory: true })]),
    );
  });

  test("does not synthesize missing text and binary read methods", async () => {
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

    const master = await createTestMasterFileSystem();

    await expect(master.readFile("/binary/data.txt")).rejects.toThrow(/read/);
    await expect(master.readFileBuffer("/notes/todo.md")).rejects.toThrow(/read/);
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

    const master = await createTestMasterFileSystem();

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

    const master = await createTestMasterFileSystem();

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

    const master = await createTestMasterFileSystem();

    await expect(master.cp("/system/SYSTEM.md", "/project/README.md")).rejects.toThrow(
      /Cross-mount copy/,
    );
    await expect(master.mv("/system/SYSTEM.md", "/project/README.md")).rejects.toThrow(
      /Cross-mount move/,
    );
  });

  test("delegates mkdir support to the mounted filesystem", async () => {
    registerFileContributor(
      makeContributor("project", "/project", {
        readOnly: false,
        persistence: "session",
        ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
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

    const master = await createTestMasterFileSystem();

    await expect(master.mkdir("/project/existing", { recursive: true })).rejects.toThrow(/mkdir/);
    await expect(master.mkdir("/project/new-folder")).rejects.toThrow(/mkdir/);
  });

  test("rejects writes to synthetic parent directories outside mounted filesystems", async () => {
    const { contributor: projectContributor } = await createInMemoryContributor({
      id: "project",
      mountPoint: "/project",
    });

    registerFileContributor(projectContributor);
    registerFileContributor(makeContributor("generated", "/generated/deep"));

    const master = await createTestMasterFileSystem();

    await expect(master.mkdir("/generated")).rejects.toThrow(/not inside a mounted filesystem/);
    await expect(master.writeFile("/generated", "nope")).rejects.toThrow(
      /not inside a mounted filesystem/,
    );
  });

  test("treats executable-looking workspace paths as normal writable files", async () => {
    const { contributor } = await createInMemoryContributor({
      id: "workspace",
      mountPoint: "/workspace",
      files: {
        "/workspace/automations/router.cm.js": "export default {};",
      },
    });
    registerFileContributor(contributor);

    const checkedPermissions: string[] = [];
    const execution = {
      actor: {
        type: "user" as const,
        id: "user-1",
        userId: "user-1",
        organizationIds: ["org_123"],
      },
      scope: { kind: "org" as const, orgId: "org_123" },
    };
    const kernel = new BackofficeKernel({
      authorizationPolicy(request) {
        checkedPermissions.push(
          ...request.requiredPermissions.map(
            (permission) => `${permission.namespace}.${permission.permission}`,
          ),
        );
        return { allowed: false, message: "semantic authorization should not run" };
      },
    });
    const master = await createTestMasterFileSystem({
      backend: "backoffice",
      execution,
      objects: context.objects,
      kernel,
      filePrincipal: kernel.resolveFilePrincipal(execution),
    });

    await master.writeFile("/workspace/automations/router.cm.js", "ok");
    expect(checkedPermissions).toEqual([]);
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

    const master = await createTestMasterFileSystem();

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
    registerFileContributor(makeContributor("generated", "/generated/deep"));

    const master = await createTestMasterFileSystem();

    await expect(master.realpath("/generated/")).resolves.toBe("/generated");
    await expect(master.realpath("/project/README.md")).resolves.toBe("/project/README.md");
  });

  test("validates mount point and relative-path normalization", () => {
    assert(normalizeMountPoint("//workspace//") === "/workspace");
    assert(normalizeRelativePath("  folder/sub/ ") === "folder/sub");
    assert(normalizeRelativePath("/") === "");
  });

  test("detects parent mount relationship", () => {
    assert(isMountPointParentOf("/system", "/system/archive"));
    assert(!isMountPointParentOf("/system", "/systematic"));
  });

  test("dynamically mounts and unmounts filesystems", async () => {
    const master = await createTestMasterFileSystem();
    const initialMountCount = master.mounts.length;

    const eventJson = '{"id":"test"}';

    master.mount({
      id: "context",
      kind: "custom",
      mountPoint: "/context",
      title: "Context",
      readOnly: true,
      persistence: "session",
      fs: createUnsupportedFileSystem(createReadOnlyFileSystemError, {
        readFile: async () => eventJson,
        readFileBuffer: async () => new TextEncoder().encode(eventJson),
        stat: async () => ({
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o444,
          size: eventJson.length,
          mtime: new Date(0),
        }),
        readdir: async () => ["event.json"],
        getAllPaths: () => ["/context", "/context/event.json"],
      }),
    });

    expect(master.mounts.length).toBe(initialMountCount + 1);
    await expect(master.readFile("/context/event.json")).resolves.toBe('{"id":"test"}');
    await expect(master.readdir("/")).resolves.toEqual(expect.arrayContaining(["context"]));

    master.unmount("/context");

    expect(master.mounts.length).toBe(initialMountCount);
    await expect(master.readdir("/")).resolves.not.toEqual(expect.arrayContaining(["context"]));
  });

  test("rejects duplicate dynamic mount points", async () => {
    const master = await createTestMasterFileSystem();

    const fs = new InMemoryFs();
    const mount = {
      id: "dup",
      kind: "custom" as const,
      mountPoint: "/system",
      title: "Dup",
      readOnly: false,
      persistence: "session" as const,
      fs: fs,
    };

    expect(() => master.mount(mount)).toThrow(/Duplicate file mount point/);
  });

  test("rejects overlapping dynamic mount points", async () => {
    const master = await createTestMasterFileSystem();
    const fs = new InMemoryFs();

    expect(() =>
      master.mount({
        id: "system-child",
        kind: "custom",
        mountPoint: "/system/examples",
        title: "System Child",
        readOnly: false,
        persistence: "session",
        fs,
      }),
    ).toThrow(/Overlapping file mount points are not supported/);
  });

  test("rejects unmount of non-existent mount point", async () => {
    const master = await createTestMasterFileSystem();
    expect(() => master.unmount("/nonexistent")).toThrow(/No mount found/);
  });

  test("mount and unmount can be used as a bracket around execution", async () => {
    const master = new MasterFileSystem({
      mounts: [],
    });

    master.mount({
      id: "temp",
      kind: "custom",
      mountPoint: "/temp",
      title: "Temp",
      readOnly: true,
      persistence: "session",
      fs: createUnsupportedFileSystem(createReadOnlyFileSystemError, {
        readFile: async () => "hello",
        readFileBuffer: async () => new TextEncoder().encode("hello"),
        stat: async () => ({
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o444,
          size: 5,
          mtime: new Date(0),
        }),
        readdir: async () => ["data.txt"],
        getAllPaths: () => ["/temp", "/temp/data.txt"],
      }),
    });

    await expect(master.readFile("/temp/data.txt")).resolves.toBe("hello");

    master.unmount("/temp");

    await expect(master.exists("/temp/data.txt")).resolves.toBe(false);
  });
});

const MOUNT_TEMPLATE = {
  kind: "custom" as const,
  title: "Root",
  readOnly: true,
  persistence: "persistent" as const,
  ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
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
    ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
    stat: fs.stat.bind(fs),
    readdir: fs.readdir.bind(fs),
    ...(typeof fs.readdirWithFileTypes === "function"
      ? {
          readdirWithFileTypes: fs.readdirWithFileTypes.bind(fs),
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
    appendFile: fs.appendFile.bind(fs),
    cp: fs.cp.bind(fs),
    mv: fs.mv.bind(fs),
    ...(options.includeRealpath === false || typeof fs.realpath !== "function"
      ? {}
      : { realpath: fs.realpath.bind(fs) }),
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
