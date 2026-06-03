import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";
import type { ResolvedFileMount } from "@/files/types";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import type { AutomationsRuntime } from "@/fragno/runtime-tools/families/automations";
import { automationIdentityRuntimeTools } from "@/fragno/runtime-tools/families/automations";

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

  test("calls automation identity tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: AutomationsRuntime = {
      lookupBinding: async (input) => {
        calls.push(["lookupBinding", input]);
        return {
          source: input.source,
          key: input.key,
          value: "user-55",
          status: "linked",
        };
      },
      bindActor: async (input) => {
        calls.push(["bindActor", input]);
        return {
          source: input.source,
          key: input.key,
          value: input.value,
          description: input.description,
          status: "linked",
        };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      tools: automationIdentityRuntimeTools,
      context: { runtimes: { automations: automationsRuntime } },
      code: `async () => {
        const existing = await automations.lookupBinding({ source: "telegram", key: "chat-123" });
        const bound = await automations.bindActor({
          source: "telegram",
          key: "chat-456",
          value: existing.value,
        });
        return { existing, bound };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      existing: { source: "telegram", key: "chat-123", value: "user-55", status: "linked" },
      bound: { source: "telegram", key: "chat-456", value: "user-55", status: "linked" },
    });
    expect(calls).toEqual([
      ["lookupBinding", { source: "telegram", key: "chat-123" }],
      ["bindActor", { source: "telegram", key: "chat-456", value: "user-55" }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "automations",
        toolName: "lookupBinding",
        toolId: "automations.identity.lookup-binding",
        inputSummary: '{"source":"telegram","key":"chat-123"}',
        status: "success",
        resultSummary: '{"source":"telegram","key":"chat-123","value":"user-55","status":"linked"}',
      },
      {
        providerName: "automations",
        toolName: "bindActor",
        toolId: "automations.identity.bind-actor",
        inputSummary: '{"source":"telegram","key":"chat-456","value":"user-55"}',
        status: "success",
      },
    ]);
  });

  test("does not expose runtime tools that were not provided", async () => {
    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      code: `async () => {
        return await automations.lookupBinding({ source: "telegram", key: "chat-123" });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  test("rejects invalid runtime tool input before calling the runtime", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: AutomationsRuntime = {
      lookupBinding: async (input) => {
        calls.push(["lookupBinding", input]);
        return null;
      },
      bindActor: async (input) => {
        calls.push(["bindActor", input]);
        return {
          source: input.source,
          key: input.key,
          value: input.value,
          description: input.description,
          status: "linked",
        };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      tools: automationIdentityRuntimeTools,
      context: { runtimes: { automations: automationsRuntime } },
      code: `async () => {
        return await automations.bindActor({ source: "telegram", key: "chat-123", value: "" });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "automations",
        toolName: "bindActor",
        inputSummary: '{"source":"telegram","key":"chat-123","value":""}',
        status: "error",
      },
    ]);
    expect(result.toolCalls[0]?.error).toContain("Too small");
    expect(calls).toEqual([]);
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
