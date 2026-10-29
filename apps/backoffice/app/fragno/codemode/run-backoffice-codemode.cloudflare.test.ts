// The Workers test pool loads the main module on first Durable Object access; load it untimed.
import "../../../workers/vitest-env";

import { afterAll, describe, expect, test, assert } from "vitest";

import {
  type BackofficeContextScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  codemodeExecutionService,
  createCodemodeInProcessExecutor,
  createCodemodeServiceExecutor,
} from "@fragno-dev/codemode/remote/codemode-service-executor";
import { env } from "cloudflare:workers";

import { unrestrictedBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type {
  BackofficeObjectHandle,
  BackofficeObjectRegistry,
  McpCommands,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRootOwnerReference } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import { drainCodemodeAlarms } from "@/fragno/codemode/codemode-alarms.test-support";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import {
  MemoryUploadObject,
  createTestStateBackend,
} from "@/fragno/codemode/state-backend.test-utils";
import type { RegisteredAutomationsRuntime } from "@/fragno/runtime-tools/bash-host";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";
import { type EventRuntime } from "@/fragno/runtime-tools/families/event";
import { createUnavailableEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { type OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { AutomationsObject } from "../../../workers/automations-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { McpObject } from "../../../workers/mcp-object";

// The test setup serves the bridge's executor in-process behind this binding.
const testCodemodeExecutor = createCodemodeServiceExecutor(
  codemodeExecutionService((env as CloudflareEnv).CODEMODE_EXECUTOR),
);

const localObjects = {
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  MCP: (input) => new McpObject(input),
} satisfies LocalBackofficeObjects;

const codemode = codemodeRunnerFor(
  createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
  createBackofficeSystemExecution({ kind: "system" }),
);

describe("runBackofficeCodemode", () => {
  afterAll(drainCodemodeAlarms);

  test("returns a compile error when the Codemode object has no compiler", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      objects: localObjects,
      env: {
        codemode: createCodemodeInProcessExecutor({
          // The test pool's Worker Loader, absent from production configuration.
          loader: (env as typeof env & { LOADER: WorkerLoader }).LOADER,
          compile: null,
        }),
      },
    });
    try {
      const result = await runBackofficeCodemode({
        codemode: codemodeRunnerFor(
          runtime.objects.codemode.singleton().commands,
          createBackofficeSystemExecution({ kind: "system" }),
        ),
        families: runtimeToolFamilies,
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
        code: "42",
      });

      expect(result).toEqual({
        runId: expect.any(String),
        result: undefined,
        error: "CODEMODE_COMPILER_UNAVAILABLE",
        errorDetails: {
          kind: "error",
          name: "Error",
          message: "CODEMODE_COMPILER_UNAVAILABLE",
          details: null,
          metadata: null,
        },
        logs: [],
        toolCalls: [],
        modules: {},
      });
    } finally {
      await runtime.cleanup();
    }
  });

  test("runs dynamic worker code with state.* against Upload", async () => {
    const upload = new MemoryUploadObject({ "input.txt": "hello" });
    const stateBackend = createTestStateBackend({ upload });

    const result = await runBackofficeCodemode({
      codemode,
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
    expect(result.logs).toContainEqual(expect.objectContaining({ text: "wrote output" }));
    await expect(stateBackend.readFile("/workspace/output.txt")).resolves.toBe("hello codemode");
  });

  test("awaits promise-valued expression codemode", async () => {
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({ "input.txt": "hello expression" }),
    });

    const result = await runBackofficeCodemode({
      codemode,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { state: stateBackend },
      }),
      code: `state.readFile({ path: "/workspace/input.txt" })`,
    });

    expect(result.error).toBeUndefined();
    assert(result.result === "hello expression");
  });

  test.each([
    { label: "primitive", code: '() => { throw "boom"; }', error: "boom" },
    {
      label: "object message",
      code: '() => { throw { message: "object boom" }; }',
      error: "object boom",
    },
    {
      label: "empty string",
      code: '() => { throw ""; }',
      error: "CODEMODE_EXECUTION_FAILED",
    },
    {
      label: "empty Error message",
      code: "() => { throw new Error(); }",
      error: "CODEMODE_EXECUTION_FAILED",
    },
  ])("reports $label throws as execution errors", async ({ code, error }) => {
    const result = await runBackofficeCodemode({
      codemode,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      code,
    });

    expect(result).toMatchObject({ result: undefined, error, toolCalls: [] });
  });

  test("returns the exact current execution scope", async () => {
    const toolContext = createTrustedSystemBackofficeToolContext({ runtimes: {} });
    const result = await runBackofficeCodemode({
      codemode,
      families: runtimeToolFamilies,
      toolContext: toolContext.createScopedContext({
        kind: "org",
        orgId: "org-1",
        jurisdiction: null,
      }),
      code: `async () => await context.getCurrentScope()`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ kind: "org", orgId: "org-1", jurisdiction: null });
    expect(result.toolCalls).toEqual([]);
  });

  test("discovers state files with glob", async () => {
    const result = await runBackofficeCodemode({
      codemode,
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
      codemode,
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
        provider: "store",
        tool: "get",
        input: '{"key":"telegram/chat-123"}',
        status: "succeeded",
        output:
          '{"id":"telegram/chat-123","key":"telegram/chat-123","value":"user-55","category":[]}',
      },
      {
        provider: "store",
        tool: "set",
        input: '{"key":"telegram/chat-456","value":"user-55"}',
        status: "succeeded",
      },
    ]);
  });

  test("calls event tools through codemode providers", async () => {
    const calls: unknown[] = [];
    const eventRuntime: EventRuntime = {
      ...createUnavailableEventRuntime(),
      emitEvent: async (input) => {
        calls.push(["emitEvent", input]);
        return {
          accepted: true,
          eventId: "event-2",
          scope: input.targetScope ?? { kind: "org", orgId: "org-1", jurisdiction: null },
          source: input.source ?? "telegram",
          eventType: input.eventType,
        };
      },
    };

    const result = await runBackofficeCodemode({
      codemode,
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
      scope: { kind: "org", orgId: "org-1", jurisdiction: null },
      source: "otp",
      eventType: "identity.bound",
    });
    expect(calls).toEqual([
      ["emitEvent", { eventType: "identity.bound", source: "otp", payload: { plan: "basic" } }],
    ]);
    expect(result.toolCalls).toMatchObject([
      {
        provider: "events",
        tool: "fire",
        status: "succeeded",
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
      codemode,
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
        provider: "otp",
        tool: "createIdentityClaim",
        status: "succeeded",
      },
    ]);
  });

  test("preserves workspace file bytes through codemode providers", async () => {
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({ "audio.oga": new Uint8Array([0, 1, 2, 255]) }),
    });

    const result = await runBackofficeCodemode({
      codemode,
      families: runtimeToolFamilies,
      toolContext: createTrustedSystemBackofficeToolContext({
        runtimes: { state: stateBackend },
      }),
      code: `async () => {
        const bytes = await state.readFileBytes({ path: "/workspace/audio.oga" });
        return { isUint8Array: bytes instanceof Uint8Array, bytes: Array.from(bytes) };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ isUint8Array: true, bytes: [0, 1, 2, 255] });
  });

  test("does not expose runtime tools that were not provided", async () => {
    const result = await runBackofficeCodemode({
      codemode,
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
      codemode,
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
        provider: "store",
        tool: "set",
        input: '{"key":"","value":""}',
        status: "failed",
      },
    ]);
    expect(result.toolCalls[0]).toMatchObject({ output: expect.stringContaining("Too small") });
    expect(calls).toEqual([]);
  });

  test("returns runtime tool errors without unhandled rejections", async () => {
    const otpRuntime: OtpRuntime = {
      createClaim: async () => {
        throw new Error("runtime tool failed");
      },
    };

    const result = await runBackofficeCodemode({
      codemode,
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
        provider: "otp",
        tool: "createIdentityClaim",
        status: "failed",
        output: "runtime tool failed",
      },
    ]);
  });

  test("supports scoped route-backed context handles", async () => {
    const calls: Array<{ scope: string; method: string; pathname: string }> = [];
    const runtime = createScopedMcpRuntimeServices(calls);
    const kernel = new BackofficeKernel(runtime);
    const routeContext = createRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime,
      kernel,
      execution: createBackofficeUserExecution({
        scope: { kind: "org", orgId: "org-1", jurisdiction: null },
        userId: "user-1",
      }),
    });
    const context = createBackofficeToolContext(routeContext);

    const result = await runBackofficeCodemode({
      codemode,
      families: runtimeToolFamilies,
      toolContext: context,
      code: `async () => {
        const list = async (handle) =>
          (await handle.list({ cursor: null })).connections.map((connection) => connection.connectionId);
        return {
          org: await list(context.org("org-1").integrations),
          user: await list(context.user("user-1").integrations),
          current: await list(integrations),
          project: await list(context.project("project-1").integrations),
        };
      }`,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      org: ["mcp#org-org-1"],
      user: ["mcp#user-user-1"],
      current: ["mcp#org-org-1"],
      project: ["mcp#project-org:org-1:project-1"],
    });
    expect(calls).toEqual([
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "user:user-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "org:org-1", method: "GET", pathname: "/api/mcp/servers" },
      { scope: "project:org:org-1:project-1", method: "GET", pathname: "/api/mcp/servers" },
    ]);
  });

  test("runs route-backed event emit tools through codemode handles", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      objects: localObjects,
      env: { codemode: testCodemodeExecutor },
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
    });
    try {
      const routeContext = createRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: runtime.services,
        kernel: new BackofficeKernel(runtime.services),
        execution: createBackofficeUserExecution({
          scope: { kind: "org", orgId: "org-1", jurisdiction: null },
          userId: "user-1",
        }),
      });

      const result = await runBackofficeCodemode({
        codemode: codemodeRunnerFor(
          runtime.objects.codemode.for(routeContext.execution.scope).commands,
          routeContext.execution,
        ),
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
          provider: "events",
          tool: "fire",
          status: "succeeded",
        },
      ]);
    } finally {
      await runtime.cleanup();
    }
  });

  test("runs project-scoped automation store tools through codemode handles", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      objects: localObjects,
      env: { codemode: testCodemodeExecutor },
    });
    try {
      const kernel = new BackofficeKernel(runtime.services);
      const routeContext = createRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: runtime.services,
        kernel,
        execution: createBackofficeSystemExecution({
          kind: "org",
          orgId: "org-1",
          jurisdiction: null,
        }),
      });

      const result = await runBackofficeCodemode({
        codemode: codemodeRunnerFor(
          runtime.objects.codemode.for(routeContext.execution.scope).commands,
          routeContext.execution,
        ),
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

      const projectScope = {
        kind: "project" as const,
        owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
        projectId: "project-1",
      };
      const orgScope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
      const projectStore = createRouteBackedAutomationStoreRuntime({
        object: runtime.objects.automations.for({
          kind: "project",
          owner: { kind: "org", orgId: "org-1", jurisdiction: null },
          projectId: "project-1",
        }),
        execution: {
          kind: "deferred" as const,
          scopeRestriction: null,
          scope: projectScope,
          actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
        },
      });
      const orgStore = createRouteBackedAutomationStoreRuntime({
        object: runtime.objects.automations.for({
          kind: "org",
          orgId: "org-1",
          jurisdiction: null,
        }),
        execution: {
          kind: "deferred" as const,
          scopeRestriction: null,
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
          scope: {
            kind: "project",
            owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
            projectId: "project-1",
          },
        }),
      );
    } finally {
      await runtime.cleanup();
    }
  });

  test("blocks direct network access by default", async () => {
    const result = await runBackofficeCodemode({
      codemode,
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
  const createMcpObject = (scope: string): BackofficeObjectHandle<McpCommands> => {
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
      return Response.json({ error: "Unexpected MCP request" }, { status: 500 });
    };
    return {
      commands: {
        getDurableHookQueue: async () => ({}) as never,
        getDurableHook: async () => null,
        wakeDurableHooks: async () => {},
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
    for: (scope: BackofficeContextScope) =>
      createMcpObject(scope.kind === "system" ? "singleton" : backofficeScopePathSegment(scope)),
  };
  // Every organization and user the handles name exists, in no jurisdiction.
  const auth = {
    singleton: () => ({
      commands: {
        findRootOwnerScope: async (owner: BackofficeRootOwnerReference) => ({
          ...owner,
          jurisdiction: null,
        }),
      },
    }),
  };
  const objects = new Proxy(
    { mcp: scoped, auth },
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
              for: () => createMcpObject(String(property)),
            },
    },
  ) as unknown as BackofficeObjectRegistry;

  return {
    objects,
    adapters: {} as BackofficeRuntimeServices["adapters"],
    authorityResolver: unrestrictedBackofficeAuthorityResolver,
    kernelObserver: noopBackofficeKernelObserver,
    codemodeExecutor: null,
    workerTypeChecker: null,
    reson8: null,
    webFetch: fetch,
    config: {
      authEmailVerification: { enabled: false },
      sandboxBackofficeBaseUrl: null,
      sandboxContainers: true,
      signUpAccessCodesRequired: true,
      localEmailLog: false,
      workersAi: false,
      bindings: {
        api: false,
        auth: false,
        automations: false,
        billing: false,
        marketplace: false,
        telegram: false,
        otp: false,
        resend: false,
        mcp: true,
        projectConnector: false,
        upload: false,
        blobs: false,
        github: false,
        githubWebhookRouter: false,
        piManager: false,
        cloudflare: false,
        sandbox: false,
      },
    },
  };
};
