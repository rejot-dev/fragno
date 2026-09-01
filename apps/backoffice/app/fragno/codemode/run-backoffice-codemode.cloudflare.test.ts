import { describe, expect, test, assert } from "vitest";

import { env } from "cloudflare:workers";

import { unrestrictedBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import type {
  BackofficeObjectHandle,
  BackofficeObjectRegistry,
  McpObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import {
  MemoryUploadObject,
  createTestStateBackend,
} from "@/fragno/codemode/state-backend.test-utils";
import type { RegisteredAutomationsRuntime } from "@/fragno/runtime-tools/bash-host";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";
import { type EventRuntime } from "@/fragno/runtime-tools/families/event";
import type { McpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { type OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import { type TelegramRuntime } from "@/fragno/runtime-tools/families/telegram";
import type { UploadRuntime } from "@/fragno/runtime-tools/families/upload-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

describe("runBackofficeCodemode", () => {
  test("runs dynamic worker code with state.* against Upload", async () => {
    const upload = new MemoryUploadObject({ "input.txt": "hello" });
    const stateBackend = createTestStateBackend({ upload });

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { state: stateBackend },
      }),
      code: `async () => {
        const input = await state.readFile({ path: "/workspace/input.txt" });
        await state.writeFile({ path: "/workspace/output.txt", content: input + " codemode" });
        console.log("wrote output");
        return await state.readFile({ path: "/workspace/output.txt" });
      }`,
    });

    expect(result.error).toBeUndefined();
    assert(result.result === "hello codemode");
    expect(result.logs).toContain("wrote output");
    await expect(stateBackend.readFile("/workspace/output.txt")).resolves.toBe("hello codemode");
  });

  test("awaits promise-valued expression codemode", async () => {
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({ "input.txt": "hello expression" }),
    });

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { state: stateBackend },
      }),
      code: `state.readFile({ path: "/workspace/input.txt" })`,
    });

    expect(result.error).toBeUndefined();
    assert(result.result === "hello expression");
  });

  test("returns the exact current execution scope", async () => {
    const toolContext = createTrustedSystemBackofficeToolContext({ runtimes: {} });
    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: toolContext.createScopedContext({ kind: "org", orgId: "org-1" }),
      code: `async () => await context.getCurrentScope()`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ kind: "org", orgId: "org-1" });
    expect(result.toolCalls).toEqual([]);
  });

  test("discovers state files with glob", async () => {
    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: {
          state: createTestStateBackend({
            upload: new MemoryUploadObject({ "automations/example.workflow.js": "example" }),
          }),
        },
      }),
      code: `async () => await state.glob({ pattern: "/workspace/automations/**/*.workflow.js" })`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(["/workspace/automations/example.workflow.js"]);
  });

  test("calls automation identity tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: RegisteredAutomationsRuntime = {
      ...createUnavailableAutomationRouterRuntime(),
      get: async (input) => {
        calls.push(["get", input]);
        return {
          id: input.key,
          key: input.key,
          value: "user-55",
          category: [],
        };
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          id: input.key,
          key: input.key,
          value: input.value,
          category: input.category ?? [],
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [] }];
      },
    };

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { automations: automationsRuntime },
      }),
      code: `async () => {
        const existing = await store.get({ key: "telegram/chat-123" });
        const bound = await store.set({
          key: "telegram/chat-456",
          value: existing.value,
        });
        return { existing, bound };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      existing: {
        id: "telegram/chat-123",
        key: "telegram/chat-123",
        value: "user-55",
        category: [],
      },
      bound: {
        id: "telegram/chat-456",
        key: "telegram/chat-456",
        value: "user-55",
        category: [],
      },
    });
    expect(calls).toEqual([
      ["get", { key: "telegram/chat-123" }],
      ["set", { key: "telegram/chat-456", value: "user-55" }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "store",
        toolName: "get",
        toolId: "store.get",
        inputSummary: '{"key":"telegram/chat-123"}',
        status: "success",
        resultSummary:
          '{"id":"telegram/chat-123","key":"telegram/chat-123","value":"user-55","category":[]}',
      },
      {
        providerName: "store",
        toolName: "set",
        toolId: "store.set",
        inputSummary: '{"key":"telegram/chat-456","value":"user-55"}',
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
          scope: input.targetScope ?? { kind: "org", orgId: "org-1" },
          source: input.source ?? "telegram",
          eventType: input.eventType,
        };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { event: eventRuntime } }),
      code: `async () => {
        return await events.fire({
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
      scope: { kind: "org", orgId: "org-1" },
      source: "otp",
      eventType: "identity.bound",
    });
    expect(calls).toEqual([
      ["emitEvent", { eventType: "identity.bound", source: "otp", payload: { plan: "basic" } }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "events",
        toolName: "fire",
        toolId: "events.fire",
        status: "success",
      },
    ]);
  });

  test("calls otp tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const actor = {
      scope: "external" as const,
      source: "telegram",
      type: "chat",
      id: "chat-123",
    };
    const otpRuntime: OtpRuntime = {
      createClaim: async (input) => {
        calls.push(["createClaim", input]);
        return {
          url: `https://example.com/claim/${actor.id}`,
          otpId: "otp-123",
          externalId: actor.id,
          code: "123456",
          actor,
          type: "identity",
        };
      },
    };

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { otp: otpRuntime } }),
      code: `async () => {
        return await otp.createIdentityClaim({ ttlMinutes: 15 });
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
    expect(calls).toEqual([["createClaim", { ttlMinutes: 15 }]]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "otp",
        toolName: "createIdentityClaim",
        toolId: "otp.identity.create-claim",
        status: "success",
      },
    ]);
  });

  test("preserves prepared upload bytes through codemode providers", async () => {
    const uploadRuntime: UploadRuntime = {
      readPrepared: async ({ file, encoding }) => {
        expect(encoding).toBe("bytes");
        return {
          file,
          encoding: "bytes",
          bytes: new Uint8Array([0, 1, 2, 255]),
          byteLength: 4,
        };
      },
      commitPrepared: async ({ file }) => ({
        kind: "uploaded-file",
        scope: file.scope,
        uploadId: file.uploadId,
        provider: file.provider,
        fileKey: file.fileKey,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
      }),
      discardPrepared: async ({ file }) => ({ discarded: true, uploadId: file.uploadId }),
    };
    const systemContext = createTrustedSystemBackofficeToolContext({
      runtimes: { upload: uploadRuntime },
    });

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: systemContext.createScopedContext({ kind: "org", orgId: "org-1" }),
      code: `async () => {
        const prepared = await upload.readPrepared({
          file: {
            kind: "prepared-upload",
            scope: { kind: "org", orgId: "org-1" },
            uploadId: "upload-1",
            provider: "database",
            fileKey: "generated-ui/audio.oga",
            filename: "audio.oga",
            sizeBytes: 4,
            contentType: "audio/ogg",
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          encoding: "bytes",
        });
        return {
          isUint8Array: prepared.bytes instanceof Uint8Array,
          bytes: Array.from(prepared.bytes),
        };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ isUint8Array: true, bytes: [0, 1, 2, 255] });
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
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { telegram: telegramRuntime },
      }),
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

  test("calls cached MCP tools through dispatcher-safe codemode providers", async () => {
    const calls: unknown[] = [];
    const mcpRuntime: McpRuntime = {
      listServers: async () => ({
        servers: [
          {
            slug: "cloudflare-mcp",
            name: "Cloudflare MCP",
            endpointUrl: "https://example.com/mcp",
            authMode: "none",
            cache: {
              tools: [
                {
                  name: "search-docs",
                  description: "Search docs.",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                },
                {
                  name: "delete",
                  description: "Call a reserved-name tool.",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                },
              ],
            },
          },
        ],
      }),
      callTool: async (input) => {
        calls.push(["callTool", input]);
        return {
          content: [{ type: "text", text: `result for ${String(input.arguments?.query ?? "")}` }],
        };
      },
      createServer: async () => {
        throw new Error("not used");
      },
      deleteServer: async () => {
        throw new Error("not used");
      },
      refreshServer: async () => {
        throw new Error("not used");
      },
      startOAuth: async () => {
        throw new Error("not used");
      },
      setToken: async () => {
        throw new Error("not used");
      },
      getAuthStatus: async () => {
        throw new Error("not used");
      },
    };

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { mcp: mcpRuntime } }),
      code: `async () => {
        const docs = await mcp_cloudflare_mcp.search_docs({ query: "fragno" });
        const reserved = await mcp_cloudflare_mcp.delete_({ query: "reserved" });
        return { docs, reserved };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      docs: { content: [{ type: "text", text: "result for fragno" }] },
      reserved: { content: [{ type: "text", text: "result for reserved" }] },
    });
    expect(calls).toEqual([
      ["callTool", { slug: "cloudflare-mcp", name: "search-docs", arguments: { query: "fragno" } }],
      ["callTool", { slug: "cloudflare-mcp", name: "delete", arguments: { query: "reserved" } }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "mcp_cloudflare_mcp",
        toolName: "search_docs",
        toolId: "mcp.cloudflare-mcp.search-docs",
        status: "success",
      },
      {
        providerName: "mcp_cloudflare_mcp",
        toolName: "delete_",
        toolId: "mcp.cloudflare-mcp.delete",
        status: "success",
      },
    ]);
  });

  test("fails fast when MCP codemode provider discovery fails", async () => {
    const mcpRuntime: McpRuntime = {
      listServers: async () => {
        throw new Error("MCP server list failed");
      },
      callTool: async () => {
        throw new Error("not used");
      },
      createServer: async () => {
        throw new Error("not used");
      },
      deleteServer: async () => {
        throw new Error("not used");
      },
      refreshServer: async () => {
        throw new Error("not used");
      },
      startOAuth: async () => {
        throw new Error("not used");
      },
      setToken: async () => {
        throw new Error("not used");
      },
      getAuthStatus: async () => {
        throw new Error("not used");
      },
    };

    await expect(
      runBackofficeCodemode({
        env,
        families: runtimeToolFamilies,
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { mcp: mcpRuntime } }),
        code: `async () => "ok"`,
      }),
    ).rejects.toThrow("MCP server list failed");
  });

  test("does not expose runtime tools that were not provided", async () => {
    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      code: `async () => {
        return await store.get({ key: "telegram/chat-123" });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  test("rejects invalid runtime tool input before calling the runtime", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: RegisteredAutomationsRuntime = {
      ...createUnavailableAutomationRouterRuntime(),
      get: async (input) => {
        calls.push(["get", input]);
        return null;
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          id: input.key,
          key: input.key,
          value: input.value,
          category: input.category ?? [],
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [] }];
      },
    };

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { automations: automationsRuntime },
      }),
      code: `async () => {
        return await store.set({ key: "", value: "" });
      }`,
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "store",
        toolName: "set",
        inputSummary: '{"key":"","value":""}',
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
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { otp: otpRuntime } }),
      code: `async () => {
        return await otp.createIdentityClaim({});
      }`,
    });

    expect(result.result).toBeUndefined();
    assert(result.error === "runtime tool failed");
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "otp",
        toolName: "createIdentityClaim",
        status: "error",
        error: "runtime tool failed",
      },
    ]);
  });

  test("supports scoped route-backed context handles", async () => {
    const calls: Array<{ scope: string; method: string; pathname: string }> = [];
    const runtime = createScopedMcpRuntimeServices(calls);
    const kernel = new BackofficeKernel(runtime);
    const routeContext = createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution: createBackofficeUserExecution({
        scope: { kind: "org", orgId: "org-1" },
        userId: "user-1",
      }),
    });
    const context = createBackofficeToolContext(routeContext);

    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: context,
      code: `async () => {
        const org = await context.org("org-1").mcp.listServers();
        const user = await context.user("user-1").mcp.listServers();
        const current = await mcp.listServers();
        const project = await context.project("project-1").mcp.listServers();
        const projectError = null;
        let deleteError = null;
        try {
          await context.org("org-1").mcp.deleteServer({ slug: "blocked" });
        } catch (error) {
          deleteError = error.message;
        }
        return { org, user, current, project, projectError, deleteError };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      org: { servers: [{ slug: "org-org-1" }] },
      user: { servers: [{ slug: "user-user-1" }] },
      current: { servers: [{ slug: "org-org-1" }] },
      project: { servers: [{ slug: "project-org-1:project-1" }] },
      projectError: null,
      deleteError: null,
    });
    expect(calls).toEqual([
      // Installed MCP provider discovery for the selected current scope.
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "user:user-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "project:org-1:project-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "org:org-1", method: "DELETE", pathname: "/api/mcp/servers/blocked" },
    ]);
  });

  test("runs route-backed event emit tools through codemode handles", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      env: { LOADER: env.LOADER },
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
    });
    try {
      const routeContext = createRouteBackedRuntimeContext({
        runtime: runtime.services,
        kernel: new BackofficeKernel(runtime.services),
        execution: createBackofficeUserExecution({
          scope: { kind: "org", orgId: "org-1" },
          userId: "user-1",
        }),
      });

      const result = await runBackofficeCodemode({
        env,
        families: runtimeToolFamilies,
        toolContext: createBackofficeToolContext(routeContext),
        code: `async () => {
          return await events.fire({
            eventType: "dashboard.test",
            source: "codemode",
            payload: { ok: true },
          });
        }`,
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        accepted: true,
        scope: { kind: "org", orgId: "org-1" },
        source: "codemode",
        eventType: "dashboard.test",
      });
      expect(result.toolCalls).toMatchObject([
        {
          providerName: "events",
          toolName: "fire",
          toolId: "events.fire",
          status: "success",
        },
      ]);
    } finally {
      await runtime.cleanup();
    }
  });

  test("runs project-scoped automation store tools through codemode handles", async () => {
    const runtime = await createInMemoryBackofficeRuntime({ env: { LOADER: env.LOADER } });
    try {
      const kernel = new BackofficeKernel(runtime.services);
      const routeContext = createRouteBackedRuntimeContext({
        runtime: runtime.services,
        kernel,
        execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
      });

      const result = await runBackofficeCodemode({
        env,
        families: runtimeToolFamilies,
        toolContext: createBackofficeToolContext(routeContext),
        code: `async () => {
          await context.project("project-1").store.set({
            key: "project-key",
            value: "from-project",
          });
          await context.current.store.set({
            key: "org-key",
            value: "from-org",
          });
          return {
            project: await context.project("project-1").store.get({ key: "project-key" }),
            org: await context.current.store.get({ key: "org-key" }),
          };
        }`,
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        project: { key: "project-key", value: "from-project" },
        org: { key: "org-key", value: "from-org" },
      });

      const projectScope = { kind: "project" as const, orgId: "org-1", projectId: "project-1" };
      const orgScope = { kind: "org" as const, orgId: "org-1" };
      const projectStore = createRouteBackedAutomationStoreRuntime({
        object: runtime.objects.automations.forProject({ orgId: "org-1", projectId: "project-1" }),
        execution: {
          scope: projectScope,
          actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
        },
      });
      const orgStore = createRouteBackedAutomationStoreRuntime({
        object: runtime.objects.automations.forOrg("org-1"),
        execution: {
          scope: orgScope,
          actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
        },
      });
      await expect(projectStore.get({ key: "project-key" })).resolves.toMatchObject({
        value: "from-project",
      });
      await expect(orgStore.get({ key: "org-key" })).resolves.toMatchObject({
        value: "from-org",
      });
      assert(
        runtime.hasObjectInstance({
          binding: "AUTOMATIONS",
          scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
        }),
      );
    } finally {
      await runtime.cleanup();
    }
  });

  test("blocks direct network access by default", async () => {
    const result = await runBackofficeCodemode({
      env,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
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

const createScopedMcpRuntimeServices = (
  calls: Array<{ scope: string; method: string; pathname: string }>,
): BackofficeRuntimeServices => {
  const createMcpObject = (scope: string): BackofficeObjectHandle<McpObject> => {
    const fetch = async (request: Request) => {
      const url = new URL(request.url);
      calls.push({ scope, method: request.method, pathname: url.pathname });
      if (request.method === "GET" && url.pathname === "/api/mcp/servers") {
        const slug = scope.replace(":", "-");
        return Response.json({
          servers: [
            {
              slug,
              name: slug,
              endpointUrl: "https://example.com/mcp",
              authMode: "none",
              cache: { tools: [] },
            },
          ],
        });
      }
      if (request.method === "DELETE") {
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Unexpected MCP request" }, { status: 500 });
    };
    return {
      commands: {
        getDurableHookQueue: async () => ({}) as never,
        getDurableHook: async () => null,
      },
      http: {
        fetch,
        fetchAuthorized: async (request) => await fetch(request),
      },
    };
  };

  const scoped = {
    singleton: () => createMcpObject("singleton"),
    forOrg: (orgId: string) => createMcpObject(`org:${orgId}`),
    forName: (name: string) => createMcpObject(`name:${name}`),
    forUser: ({ userId }: { userId: string }) => createMcpObject(`user:${userId}`),
    forProject: ({ orgId, projectId }: { orgId: string; projectId: string }) =>
      createMcpObject(`project:${orgId}:${projectId}`),
  };
  const objects = new Proxy(
    { mcp: scoped },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : {
              singleton: () => createMcpObject(String(property)),
              forOrg: () => createMcpObject(String(property)),
              forName: () => createMcpObject(String(property)),
              forUser: () => createMcpObject(String(property)),
              forProject: () => createMcpObject(String(property)),
            },
    },
  ) as unknown as BackofficeObjectRegistry;

  return {
    objects,
    adapters: {} as BackofficeRuntimeServices["adapters"],
    authorityResolver: unrestrictedBackofficeAuthorityResolver,
    kernelObserver: noopBackofficeKernelObserver,
    config: {
      authEmailVerification: { enabled: false },
      bindings: {
        api: false,
        auth: false,
        automations: false,
        billing: false,
        marketplace: false,
        telegram: false,
        otp: false,
        resend: false,
        reson8: false,
        mcp: true,
        upload: false,
        github: false,
        githubWebhookRouter: false,
        cloudflare: false,
        sandbox: false,
      },
    },
  };
};
