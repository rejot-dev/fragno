import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";
import type { ResolvedFileMount } from "@/files/types";

import { createPiToolRegistry } from "./pi";
import { createPiCodemodeRuntime } from "./pi-codemode";

describe("Pi runStateCode tool", () => {
  test("runs codemode against a session filesystem and persists writes", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/input.txt": "hello",
    });
    const sessionFileSystems = new Map<string, Promise<MasterFileSystem>>([
      ["session-1", Promise.resolve(fs)],
    ]);

    const tools = createPiToolRegistry({
      sessionFileSystems,
      sessionFileSystemContext: {
        orgId: "org-1",
        env,
      },
      codemode: createPiCodemodeRuntime(env),
    });

    const runStateCodeFactory = tools.runStateCode;
    if (typeof runStateCodeFactory !== "function") {
      throw new Error("Expected runStateCode tool to be registered as a factory.");
    }

    const tool = await runStateCodeFactory({
      session: { id: "session-1" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const result = await tool.execute("tool-call-1", {
      code: `async () => {
        const input = await state.readFile("/workspace/input.txt");
        await state.writeFile("/workspace/output.txt", input + " from pi");
        return await state.readFile("/workspace/output.txt");
      }`,
    });

    expect(result.details).toMatchObject({
      result: "hello from pi",
      logs: [],
    });
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from runStateCode.");
    }
    expect(content.text).toContain("hello from pi");
    await expect(fs.readFile("/workspace/output.txt")).resolves.toBe("hello from pi");
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
