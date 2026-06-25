import { describe, expect, test, assert } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry, McpObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { MasterFileSystem } from "@/files/master-file-system";
import type { ResolvedFileMount } from "@/files/types";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import type { AutomationStoreRuntime } from "@/fragno/runtime-tools/families/automations-bindings";
import { type EventRuntime } from "@/fragno/runtime-tools/families/event";
import type { McpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { type OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import { type TelegramRuntime } from "@/fragno/runtime-tools/families/telegram";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

describe("runBackofficeCodemode", () => {
  test("runs dynamic worker code with state.* against a mounted filesystem", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/input.txt": "hello",
    });

    const result = await runBackofficeCodemode({
      env,
      fs,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      code: `async () => {
        const input = await state.readFile("/workspace/input.txt");
        await state.writeFile("/workspace/output.txt", input + " codemode");
        console.log("wrote output");
        return await state.readFile("/workspace/output.txt");
      }`,
    });

    expect(result.error).toBeUndefined();
    assert(result.result === "hello codemode");
    expect(result.logs).toContain("wrote output");
    await expect(fs.readFile("/workspace/output.txt")).resolves.toBe("hello codemode");
  });

  test("awaits promise-valued expression codemode", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/input.txt": "hello expression",
    });

    const result = await runBackofficeCodemode({
      env,
      fs,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      code: `state.readFile("/workspace/input.txt")`,
    });

    expect(result.error).toBeUndefined();
    assert(result.result === "hello expression");
  });

  test("reports unsupported test state tools explicitly", async () => {
    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      code: `async () => await state.find("/")`,
    });

    assert(result.error === "state.find is not implemented for test codemode.");
  });

  test("calls automation identity tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const actor = { scope: "external", source: "telegram", type: "chat", id: "chat-123" } as const;
    const automationsRuntime: AutomationStoreRuntime = {
      get: async (input) => {
        calls.push(["get", input]);
        return {
          key: input.key,
          value: "user-55",
          category: [],
          actor,
        };
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          key: input.key,
          value: input.value,
          category: input.category ?? [],
          actor: input.actor,
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [], actor }];
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { automations: automationsRuntime },
      }),
      code: `async () => {
        const existing = await store.get({ key: "telegram/chat-123" });
        const bound = await store.set({
          key: "telegram/chat-456",
          value: existing.value,
          actor: existing.actor,
        });
        return { existing, bound };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      existing: { key: "telegram/chat-123", value: "user-55", category: [], actor },
      bound: { key: "telegram/chat-456", value: "user-55", category: [], actor },
    });
    expect(calls).toEqual([
      ["get", { key: "telegram/chat-123" }],
      ["set", { key: "telegram/chat-456", value: "user-55", actor }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "store",
        toolName: "get",
        toolId: "store.get",
        inputSummary: '{"key":"telegram/chat-123"}',
        status: "success",
        resultSummary:
          '{"key":"telegram/chat-123","value":"user-55","category":[],"actor":{"scope":"external","type":"chat","id":"chat-123","source":"telegram"}}',
      },
      {
        providerName: "store",
        toolName: "set",
        toolId: "store.set",
        inputSummary:
          '{"key":"telegram/chat-456","value":"user-55","actor":{"scope":"external","type":"chat","id":"chat-123","source":"telegram"}}',
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
      fs: createTestMasterFileSystem({}),
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { event: eventRuntime } }),
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
      scope: { kind: "org", orgId: "org-1" },
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
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { otp: otpRuntime } }),
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
        return { content: [{ type: "text", text: `result for ${input.arguments?.query}` }] };
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
      fs: createTestMasterFileSystem({}),
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
        fs: createTestMasterFileSystem({}),
        families: runtimeToolFamilies,
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { mcp: mcpRuntime } }),
        code: `async () => "ok"`,
      }),
    ).rejects.toThrow("MCP server list failed");
  });

  test("does not expose runtime tools that were not provided", async () => {
    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
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
    const actor = { scope: "external", source: "telegram", type: "chat", id: "chat-123" } as const;
    const automationsRuntime: AutomationStoreRuntime = {
      get: async (input) => {
        calls.push(["get", input]);
        return null;
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          key: input.key,
          value: input.value,
          category: input.category ?? [],
          actor: input.actor,
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [], actor }];
      },
    };

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
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
      fs: createTestMasterFileSystem({}),
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: { otp: otpRuntime } }),
      code: `async () => {
        return await otp.createIdentityClaim({
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
        });
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

  test("supports scoped route-backed context handles and denies before Durable Object calls", async () => {
    const calls: Array<{ scope: string; method: string; pathname: string }> = [];
    const runtime = createScopedMcpRuntimeServices(calls);
    const kernel = new BackofficeKernel({
      objects: runtime.objects,
      authorizationPolicy: (request) => {
        if (
          request.scope.kind === "org" &&
          request.requiredPermissions.some(
            (permission) =>
              permission.namespace === "mcp" && permission.permission === "servers.delete",
          )
        ) {
          return { allowed: false, message: "Denied mcp.servers.delete" };
        }
        return { allowed: true };
      },
    });
    const routeContext = createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution: {
        actor: {
          type: "user",
          id: "user-1",
          userId: "user-1",
          organizationIds: ["org-1"],
        },
        scope: { kind: "org", orgId: "org-1" },
      },
    });
    const context = createBackofficeToolContext(routeContext);

    const result = await runBackofficeCodemode({
      env,
      fs: createTestMasterFileSystem({}),
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
      deleteError: "Denied mcp.servers.delete",
    });
    expect(calls).toEqual([
      // Installed MCP provider discovery for the selected current scope.
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "user:user-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "project:org-1:project-1", method: "GET", pathname: "/api/mcp/servers" },
    ]);
  });

  test("runs project-scoped automation store tools through codemode handles", async () => {
    const runtime = await createInMemoryBackofficeRuntime({ env: { LOADER: env.LOADER } });
    try {
      const kernel = new BackofficeKernel({ objects: runtime.objects });
      const routeContext = createRouteBackedRuntimeContext({
        runtime: runtime.services,
        kernel,
        execution: {
          actor: {
            type: "user",
            id: "user-1",
            userId: "user-1",
            organizationIds: ["org-1"],
          },
          scope: { kind: "org", orgId: "org-1" },
        },
      });

      const result = await runBackofficeCodemode({
        env,
        fs: createTestMasterFileSystem({}),
        families: runtimeToolFamilies,
        toolContext: createBackofficeToolContext(routeContext),
        code: `async () => {
          await context.project("project-1").store.set({
            key: "project-key",
            value: "from-project",
            actor: { scope: "internal", type: "system", id: "test" },
          });
          await context.current.store.set({
            key: "org-key",
            value: "from-org",
            actor: { scope: "internal", type: "system", id: "test" },
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

      const projectStore = createRouteBackedAutomationStoreRuntime({
        object: runtime.objects.automations.forProject({ orgId: "org-1", projectId: "project-1" }),
      });
      const orgStore = createRouteBackedAutomationStoreRuntime({
        object: runtime.objects.automations.forOrg("org-1"),
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
      fs: createTestMasterFileSystem({}),
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
  const createMcpObject = (scope: string): McpObject => ({
    fetch: async (request) => {
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
    },
    getAdminConfig: async () => ({ configured: true }),
    resetAdminConfig: async () => ({ configured: false }),
    setAdminConfig: async () => ({ configured: true }),
    getDurableHookRepository: async () => ({}) as never,
  });

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
    config: {
      bindings: {
        api: false,
        auth: false,
        automations: false,
        telegram: false,
        otp: false,
        pi: false,
        resend: false,
        reson8: false,
        mcp: true,
        upload: false,
        github: false,
        cloudflareWorkers: false,
        githubWebhookRouter: false,
        sandbox: false,
      },
    },
  };
};

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
