import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";
import type { ResolvedFileMount } from "@/files/types";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";

describe("runBackofficeCodemode", () => {
  test("runs dynamic worker code with state.* against a mounted filesystem", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/input.txt": "hello",
    });

    const result = await runBackofficeCodemode({
      env,
      fs,
      code: `async () => {
        const input = await state.readFile("/workspace/input.txt");
        await state.writeFile("/workspace/output.txt", input + " codemode");
        console.log("wrote output");
        return await state.readFile("/workspace/output.txt");
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello codemode");
    expect(result.logs).toContain("wrote output");
    await expect(fs.readFile("/workspace/output.txt")).resolves.toBe("hello codemode");
  });

  test("blocks direct network access by default", async () => {
    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      code: `async () => {
        await fetch("https://example.com/");
        return "network was reachable";
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("network was reachable");
  });
});

const createTestMasterFileSystem = (files: Record<string, string | Uint8Array>): MasterFileSystem =>
  new MasterFileSystem({
    mounts: [createMount("workspace", "/workspace", files)],
  });

const createMount = (
  id: string,
  mountPoint: string,
  files: Record<string, string | Uint8Array>,
): ResolvedFileMount => ({
  id,
  kind: "custom",
  mountPoint,
  title: id,
  readOnly: false,
  persistence: "session",
  fs: normalizeMountedFileSystem(createMountedInMemoryFs(files), { readOnly: false }),
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
