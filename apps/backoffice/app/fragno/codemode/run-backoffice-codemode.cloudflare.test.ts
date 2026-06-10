import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import type { ResolvedFileMount } from "@/files/types";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import type { AutomationBindingsRuntime } from "@/fragno/runtime-tools/families/automations-bindings";
import { automationBindingsRuntimeTools } from "@/fragno/runtime-tools/families/automations-bindings";
import { eventRuntimeTools, type EventRuntime } from "@/fragno/runtime-tools/families/event";
import { otpRuntimeTools, type OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import {
  telegramRuntimeTools,
  type TelegramRuntime,
} from "@/fragno/runtime-tools/families/telegram";

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
    const automationsRuntime: AutomationBindingsRuntime = {
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
      tools: automationBindingsRuntimeTools,
      context: { runtimes: { automations: automationsRuntime } },
      code: `async () => {
        const existing = await identity.lookupBinding({ source: "telegram", key: "chat-123" });
        const bound = await identity.bindActor({
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
        providerName: "identity",
        toolName: "lookupBinding",
        toolId: "identity.lookup-binding",
        inputSummary: '{"source":"telegram","key":"chat-123"}',
        status: "success",
        resultSummary: '{"source":"telegram","key":"chat-123","value":"user-55","status":"linked"}',
      },
      {
        providerName: "identity",
        toolName: "bindActor",
        toolId: "identity.bind-actor",
        inputSummary: '{"source":"telegram","key":"chat-456","value":"user-55"}',
        status: "success",
      },
    ]);
  });

  test("calls event tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const eventRuntime: EventRuntime = {
      emitEvent: async (input) => {
        calls.push(["emitEvent", input]);
        return {
          accepted: true,
          eventId: "event-2",
          orgId: "org-1",
          source: input.source ?? "telegram",
          eventType: input.eventType,
        };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      tools: eventRuntimeTools,
      context: { runtimes: { event: eventRuntime } },
      code: `async () => {
        return await event.emit({
          eventType: "identity.bound",
          source: "otp",
          payload: { plan: "basic" },
        });
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      accepted: true,
      eventId: "event-2",
      orgId: "org-1",
      source: "otp",
      eventType: "identity.bound",
    });
    expect(calls).toEqual([
      ["emitEvent", { eventType: "identity.bound", source: "otp", payload: { plan: "basic" } }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "event",
        toolName: "emit",
        toolId: "event.emit",
        status: "success",
      },
    ]);
  });

  test("calls otp tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const otpRuntime: OtpRuntime = {
      createClaim: async (input) => {
        calls.push(["createClaim", input]);
        return {
          url: `https://example.com/claim/${input.actor.id}`,
          otpId: "otp-123",
          externalId: input.actor.id,
          code: "123456",
          actor: input.actor,
          type: "identity",
        };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      tools: otpRuntimeTools,
      context: { runtimes: { otp: otpRuntime } },
      code: `async () => {
        return await otp.createIdentityClaim({
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
          ttlMinutes: 15,
        });
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      url: "https://example.com/claim/chat-123",
      otpId: "otp-123",
      externalId: "chat-123",
      code: "123456",
      actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
      type: "identity",
    });
    expect(calls).toEqual([
      [
        "createClaim",
        {
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
          ttlMinutes: 15,
        },
      ],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "otp",
        toolName: "createIdentityClaim",
        toolId: "otp.identity.create-claim",
        status: "success",
      },
    ]);
  });

  test("calls telegram tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const telegramRuntime: TelegramRuntime = {
      getFile: async (input) => {
        calls.push(["getFile", input]);
        return { fileId: input.fileId, filePath: `voice/${input.fileId}.ogg`, fileSize: 4 };
      },
      downloadFile: async (input) => {
        calls.push(["downloadFile", input]);
        return new Response(new Uint8Array([0, 1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        });
      },
      sendMessage: async (input) => {
        calls.push(["sendMessage", input]);
        return { ok: true, queued: true };
      },
      sendChatAction: async (input) => {
        calls.push(["sendChatAction", input]);
        return { ok: true };
      },
      editMessage: async (input) => {
        calls.push(["editMessage", input]);
        return { ok: true, queued: true };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      tools: telegramRuntimeTools,
      context: { runtimes: { telegram: telegramRuntime } },
      code: `async () => {
        const file = await telegram.getFile({ fileId: "file-1" });
        const sent = await telegram.sendMessage({ chatId: "chat-1", text: "Hello" });
        const downloaded = await telegram.downloadFile({ fileId: file.fileId });
        return { file, sent, downloaded };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      file: { fileId: "file-1", filePath: "voice/file-1.ogg", fileSize: 4 },
      sent: { ok: true, queued: true },
      downloaded: {
        bytes: [0, 1, 2],
        contentType: "application/octet-stream",
      },
    });
    expect(calls).toEqual([
      ["getFile", { fileId: "file-1" }],
      ["sendMessage", { chatId: "chat-1", text: "Hello" }],
      ["downloadFile", { fileId: "file-1" }],
    ]);
    expect(result.toolCalls).toMatchObject([
      { providerName: "telegram", toolName: "getFile", toolId: "telegram.file.get" },
      { providerName: "telegram", toolName: "sendMessage", toolId: "telegram.chat.send" },
      { providerName: "telegram", toolName: "downloadFile", toolId: "telegram.file.download" },
    ]);
  });

  test("does not expose runtime tools that were not provided", async () => {
    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      code: `async () => {
        return await identity.lookupBinding({ source: "telegram", key: "chat-123" });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  test("rejects invalid runtime tool input before calling the runtime", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: AutomationBindingsRuntime = {
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
      tools: automationBindingsRuntimeTools,
      context: { runtimes: { automations: automationsRuntime } },
      code: `async () => {
        return await identity.bindActor({ source: "telegram", key: "chat-123", value: "" });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "identity",
        toolName: "bindActor",
        inputSummary: '{"source":"telegram","key":"chat-123","value":""}',
        status: "error",
      },
    ]);
    expect(result.toolCalls[0]?.error).toContain("Too small");
    expect(calls).toEqual([]);
  });

  test("returns runtime tool errors without unhandled rejections", async () => {
    const otpRuntime: OtpRuntime = {
      createClaim: async () => {
        throw new Error("runtime tool failed");
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      tools: otpRuntimeTools,
      context: { runtimes: { otp: otpRuntime } },
      code: `async () => {
        return await otp.createIdentityClaim({
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
        });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBe("runtime tool failed");
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "otp",
        toolName: "createIdentityClaim",
        status: "error",
        error: "runtime tool failed",
      },
    ]);
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
