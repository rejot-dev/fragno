import { describe, expect, test } from "vitest";

import { InMemoryFs } from "just-bash";

import { FileSystemStateBackend } from "@cloudflare/shell";

import { MasterFileSystem } from "@/files/master-file-system";
import type { ResolvedFileMount } from "@/files/types";

import { BackofficeStateFileSystem } from "./master-file-system-state";

describe("BackofficeStateFileSystem", () => {
  test("adapts reads, writes, mkdir, rm, stat, and directory entries", async () => {
    const masterFs = createTestMasterFileSystem({
      "/workspace/readme.md": "hello",
    });
    const stateFs = new BackofficeStateFileSystem(masterFs);

    expect(await stateFs.readFile("/workspace/readme.md")).toBe("hello");
    expect(await stateFs.stat("/workspace/readme.md")).toMatchObject({
      type: "file",
      size: 5,
    });

    await stateFs.mkdir("/workspace/docs", { recursive: true });
    await stateFs.writeFile("/workspace/docs/plan.md", "ship it");
    await stateFs.writeFileBytes("/workspace/docs/data.bin", new TextEncoder().encode("bytes"));
    await stateFs.appendFile("/workspace/docs/plan.md", "\nnow");

    expect(await stateFs.readFile("/workspace/docs/plan.md")).toBe("ship it\nnow");
    expect(await stateFs.readFileBytes("/workspace/docs/data.bin")).toEqual(
      new TextEncoder().encode("bytes"),
    );
    await expect(stateFs.stat("/workspace/docs")).resolves.toMatchObject({ type: "directory" });
    await expect(stateFs.readdirWithFileTypes("/workspace/docs")).resolves.toEqual(
      expect.arrayContaining([
        { name: "data.bin", type: "file" },
        { name: "plan.md", type: "file" },
      ]),
    );

    await stateFs.rm("/workspace/docs/data.bin");
    await expect(stateFs.readFileBytes("/workspace/docs/data.bin")).rejects.toThrow(/ENOENT/);
  });

  test("delegates read-only mount enforcement to the master filesystem", async () => {
    const masterFs = createTestMasterFileSystem(
      {
        "/workspace/editable.txt": "ok",
      },
      {
        "/system/prompt.md": "readonly",
      },
    );
    const stateFs = new BackofficeStateFileSystem(masterFs);

    await stateFs.writeFile("/workspace/editable.txt", "updated");
    await expect(stateFs.writeFile("/system/prompt.md", "nope")).rejects.toThrow(/read-only/i);
    await expect(stateFs.mkdir("/system/generated")).rejects.toThrow(/read-only/i);
  });

  test("supports glob from mounted filesystem paths", async () => {
    const masterFs = createTestMasterFileSystem({
      "/workspace/docs/one.md": "one",
      "/workspace/docs/two.txt": "two",
      "/workspace/src/index.ts": "export {};",
    });
    const stateFs = new BackofficeStateFileSystem(masterFs);

    await expect(stateFs.glob("/workspace/**/*.md")).resolves.toEqual(["/workspace/docs/one.md"]);
    await expect(stateFs.glob("/workspace/**/*.{md,ts}")).resolves.toEqual([
      "/workspace/docs/one.md",
      "/workspace/src/index.ts",
    ]);
  });

  test("glob traverses the filesystem instead of relying on sparse known paths", async () => {
    const masterFs = createTestMasterFileSystem({
      "/workspace/docs/one.md": "one",
      "/workspace/docs/nested/two.md": "two",
      "/workspace/docs/nested/ignored.txt": "ignored",
    });
    const stateFs = new BackofficeStateFileSystem(masterFs);

    const originalGetAllPaths = masterFs.getAllPaths.bind(masterFs);
    masterFs.getAllPaths = () => originalGetAllPaths().filter((path) => !path.includes("nested"));

    await expect(stateFs.glob("/workspace/**/*.md")).resolves.toEqual([
      "/workspace/docs/nested/two.md",
      "/workspace/docs/one.md",
    ]);
  });

  test("glob supports *, ?, globstar, and simple brace alternates", async () => {
    const masterFs = createTestMasterFileSystem({
      "/workspace/src/app.ts": "app",
      "/workspace/src/app.tsx": "appx",
      "/workspace/src/a.test.ts": "test",
      "/workspace/src/deep/view.tsx": "view",
      "/workspace/src/deep/view.jsx": "view jsx",
      "/workspace/src/deep/view.md": "view md",
    });
    const stateFs = new BackofficeStateFileSystem(masterFs);

    await expect(stateFs.glob("/workspace/src/*.ts")).resolves.toEqual([
      "/workspace/src/a.test.ts",
      "/workspace/src/app.ts",
    ]);
    await expect(stateFs.glob("/workspace/src/app.ts?")).resolves.toEqual([
      "/workspace/src/app.tsx",
    ]);
    await expect(stateFs.glob("/workspace/src/**/*.{ts,tsx}")).resolves.toEqual([
      "/workspace/src/a.test.ts",
      "/workspace/src/app.ts",
      "/workspace/src/app.tsx",
      "/workspace/src/deep/view.tsx",
    ]);
  });

  test("glob returns an empty result when its literal root does not exist", async () => {
    const stateFs = new BackofficeStateFileSystem(createTestMasterFileSystem({}));

    await expect(stateFs.glob("/missing/**/*.ts")).resolves.toEqual([]);
  });

  test("creates a FileSystemStateBackend for state.* operations", async () => {
    const masterFs = createTestMasterFileSystem({
      "/workspace/input.json": JSON.stringify({ count: 1 }),
    });
    const backend = new FileSystemStateBackend(new BackofficeStateFileSystem(masterFs));

    expect(backend).toBeInstanceOf(FileSystemStateBackend);
    await expect(backend.readJson("/workspace/input.json")).resolves.toEqual({ count: 1 });

    await backend.writeFile("/workspace/output.txt", "done");
    await expect(masterFs.readFile("/workspace/output.txt")).resolves.toBe("done");
  });
});

const createTestMasterFileSystem = (
  workspaceFiles: Record<string, string | Uint8Array>,
  systemFiles: Record<string, string | Uint8Array> = {},
): MasterFileSystem =>
  new MasterFileSystem({
    mounts: [
      createMount("workspace", "/workspace", workspaceFiles, false),
      createMount("system", "/system", systemFiles, true),
    ],
  });

const createMount = (
  id: string,
  mountPoint: string,
  files: Record<string, string | Uint8Array>,
  readOnly: boolean,
): ResolvedFileMount => ({
  id,
  kind: readOnly ? "static" : "custom",
  mountPoint,
  title: id,
  readOnly,
  persistence: "session",
  fs: createMountedInMemoryFs(files),
});

const createMountedInMemoryFs = (files: Record<string, string | Uint8Array>) => {
  const fs = new InMemoryFs(files);

  return {
    readFile: (path: string) => fs.readFile(path),
    readFileBuffer: (path: string) => fs.readFileBuffer(path),
    writeFile: (path: string, content: string | Uint8Array) => fs.writeFile(path, content),
    appendFile: (path: string, content: string | Uint8Array) => fs.appendFile(path, content),
    exists: (path: string) => fs.exists(path),
    stat: (path: string) => fs.stat(path),
    mkdir: (path: string, options?: { recursive?: boolean }) => fs.mkdir(path, options),
    readdir: (path: string) => fs.readdir(path),
    readdirWithFileTypes: (path: string) => fs.readdirWithFileTypes(path),
    rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => fs.rm(path, options),
    cp: (src: string, dest: string, options?: { recursive?: boolean }) => fs.cp(src, dest, options),
    mv: (src: string, dest: string) => fs.mv(src, dest),
    resolvePath: (base: string, path: string) => fs.resolvePath(base, path),
    getAllPaths: () => fs.getAllPaths(),
    chmod: (path: string, mode: number) => fs.chmod(path, mode),
    symlink: (target: string, linkPath: string) => fs.symlink(target, linkPath),
    link: (existingPath: string, newPath: string) => fs.link(existingPath, newPath),
    readlink: (path: string) => fs.readlink(path),
    lstat: (path: string) => fs.lstat(path),
    realpath: (path: string) => fs.realpath(path),
    utimes: (path: string, atime: Date, mtime: Date) => fs.utimes(path, atime, mtime),
  };
};
