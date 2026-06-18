import { describe, expect, test } from "vitest";

import { Bash, InMemoryFs } from "just-bash";
import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";

import type { AutomationStoreRuntime } from "./families/automations-bindings";
import { automationStoreRuntimeTools } from "./families/automations-bindings";
import {
  backofficeCapabilitiesRuntimeTools,
  type BackofficeCapabilitiesRuntime,
} from "./families/backoffice-capabilities";
import { eventRuntimeTools, type EventRuntime } from "./families/event";
import {
  createBackofficeBashCommands,
  createTrustedSystemBackofficeToolContext,
  defineBackofficeRuntimeTool,
} from "./runtime-tools";

describe("createBackofficeBashCommands", () => {
  test("routes generated bash commands through semantic runtime tools", async () => {
    const calls: unknown[] = [];
    const commandCallsResult: { command: string; output: string; exitCode: number }[] = [];
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

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: automationStoreRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { automations: automationsRuntime },
        }),
        commandCallsResult,
      }),
    });

    await expect(
      bash.exec("store.get --key telegram/chat-123 --print value"),
    ).resolves.toMatchObject({ stdout: "user-55\n", exitCode: 0 });

    await expect(
      bash.exec(
        'store.set --key telegram/chat-123 --value user-55 --actor \'{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}\' --format json',
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      bash.exec("store.delete --key telegram/chat-123 --format json"),
    ).resolves.toMatchObject({
      exitCode: 0,
    });

    await expect(
      bash.exec("store.list --prefix telegram/ --limit 10 --format json"),
    ).resolves.toMatchObject({
      exitCode: 0,
    });

    expect(calls).toEqual([
      ["get", { key: "telegram/chat-123" }],
      ["set", { key: "telegram/chat-123", value: "user-55", actor }],
      ["delete", { key: "telegram/chat-123" }],
      ["list", { prefix: "telegram/", limit: 10 }],
    ]);
    expect(commandCallsResult.map((call) => call.command)).toEqual([
      "store.get",
      "store.set",
      "store.delete",
      "store.list",
    ]);
  });

  test("uses the default actor for store.set when --actor is omitted", async () => {
    const calls: unknown[] = [];
    const actor = { scope: "internal", type: "user", id: "user-1" } as const;
    const automationsRuntime: AutomationStoreRuntime = {
      get: async () => null,
      set: async (input) => {
        calls.push(["set", input]);
        return { key: input.key, value: input.value, category: [], actor: input.actor };
      },
      delete: async () => null,
      list: async () => [],
    };

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: automationStoreRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { automations: automationsRuntime },
          defaults: { actor },
        }),
        commandCallsResult: [],
      }),
    });

    await expect(
      bash.exec("store.set --key dashboard/example --value configured --format json"),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(calls).toEqual([["set", { key: "dashboard/example", value: "configured", actor }]]);
  });

  test("requires store.set --actor when no default actor is available", async () => {
    const automationsRuntime: AutomationStoreRuntime = {
      get: async () => null,
      set: async () => {
        throw new Error("set should not be called");
      },
      delete: async () => null,
      list: async () => [],
    };

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: automationStoreRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { automations: automationsRuntime },
        }),
        commandCallsResult: [],
      }),
    });

    await expect(
      bash.exec("store.set --key dashboard/example --value configured"),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Missing required option --actor"),
    });
  });

  test("authorizes bash commands before executing runtime tools", async () => {
    const calls: unknown[] = [];
    const actor = { scope: "external", source: "telegram", type: "chat", id: "chat-123" } as const;
    const automationsRuntime: AutomationStoreRuntime = {
      get: async (input) => {
        calls.push(["get", input]);
        return { key: input.key, value: "value", category: [], actor };
      },
      set: async (input) => {
        calls.push(["set", input]);
        return { key: input.key, value: input.value, category: [], actor: input.actor };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async () => [],
    };

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: automationStoreRuntimeTools,
        context: {
          actor: { type: "user", id: "user-1", userId: "user-1", organizationIds: ["org-1"] },
          scope: { kind: "org", orgId: "org-1" },
          kernel: new BackofficeKernel({
            authorizationPolicy: (request) =>
              request.requiredPermissions.some(
                (permission) =>
                  permission.namespace === "store" && permission.permission === "modify",
              )
                ? { allowed: false, message: "Denied store.modify" }
                : { allowed: true },
          }),
          createScopedContext: () =>
            createTrustedSystemBackofficeToolContext({
              runtimes: { automations: automationsRuntime },
            }),
          runtimes: { automations: automationsRuntime },
        },
        commandCallsResult: [],
      }),
    });

    await expect(bash.exec("store.get --key telegram/chat-123")).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(bash.exec("store.delete --key telegram/chat-123")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "Denied store.modify\n",
    });
    expect(calls).toEqual([["get", { key: "telegram/chat-123" }]]);
  });

  test("routes generated event bash commands through semantic runtime tools", async () => {
    const calls: unknown[] = [];
    const commandCallsResult: { command: string; output: string; exitCode: number }[] = [];
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

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: eventRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({ runtimes: { event: eventRuntime } }),
        commandCallsResult,
      }),
    });

    await expect(
      bash.exec(
        'event.emit --event-type identity.bound --source otp --payload-json \'{"plan":"basic"}\' --target-scope-json \'{"kind":"org","orgId":"org-2"}\' --print eventId',
      ),
    ).resolves.toMatchObject({ stdout: "event-2\n", exitCode: 0 });

    expect(calls).toEqual([
      [
        "emitEvent",
        {
          eventType: "identity.bound",
          source: "otp",
          payload: { plan: "basic" },
          targetScope: { kind: "org", orgId: "org-2" },
        },
      ],
    ]);
    expect(commandCallsResult).toEqual([{ command: "event.emit", output: "event-2", exitCode: 0 }]);
  });

  test("rejects invalid event target scopes before executing the event runtime", async () => {
    const calls: unknown[] = [];
    const eventRuntime: EventRuntime = {
      emitEvent: async (input) => {
        calls.push(input);
        return {
          accepted: true,
          eventId: "event-2",
          scope: { kind: "org", orgId: "org-1" },
          source: input.source ?? "telegram",
          eventType: input.eventType,
        };
      },
    };

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: eventRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({ runtimes: { event: eventRuntime } }),
        commandCallsResult: [],
      }),
    });

    await expect(
      bash.exec(
        'event.emit --event-type identity.bound --target-scope-json \'{"kind":"org","orgId":""}\'',
      ),
    ).resolves.toMatchObject({ exitCode: 1, stdout: "" });
    expect(calls).toEqual([]);
  });

  test("passes connections.configure --json as the payload option", async () => {
    const calls: unknown[] = [];
    const backofficeRuntime = createBackofficeRuntime({
      configureConnection: async (input) => {
        calls.push(["configureConnection", input]);
        return {
          id: "mcp",
          label: "MCP",
          kind: "connection",
          configured: true,
          config: input.payload as Record<string, unknown>,
        };
      },
    });

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: backofficeCapabilitiesRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { backoffice: backofficeRuntime },
        }),
        commandCallsResult: [],
      }),
    });

    await expect(bash.exec("connections.configure --id mcp --json {}")).resolves.toMatchObject({
      exitCode: 0,
    });

    expect(calls).toEqual([["configureConnection", { id: "mcp", payload: {} }]]);
  });

  test("prints connections.configure JSON output with --format json", async () => {
    const backofficeRuntime = createBackofficeRuntime({
      configureConnection: async (input) => ({
        id: "mcp",
        label: "MCP",
        kind: "connection",
        configured: true,
        config: input.payload as Record<string, unknown>,
      }),
    });

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: backofficeCapabilitiesRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { backoffice: backofficeRuntime },
        }),
        commandCallsResult: [],
      }),
    });

    await expect(
      bash.exec(`connections.configure --id mcp --json '{"enabled":true}' --format json`),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"configured":true'),
    });
  });

  test("requires a connections.configure --json payload", async () => {
    const backofficeRuntime = createBackofficeRuntime();
    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: backofficeCapabilitiesRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { backoffice: backofficeRuntime },
        }),
        commandCallsResult: [],
      }),
    });

    await expect(bash.exec("connections.configure --id mcp --json")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("--json requires a value"),
    });
  });

  test("rejects invalid output options before executing a runtime tool", async () => {
    const calls: unknown[] = [];
    const bash = createTestBash([
      defineBackofficeRuntimeTool({
        id: "test.echo",
        namespace: "test",
        name: "echo",
        description: "Echo a value.",
        requiredPermissions: [],
        inputSchema: z.object({ value: z.string().min(1) }),
        outputSchema: z.object({ value: z.string() }),
        execute: async (input) => {
          calls.push(input);
          return input;
        },
        adapters: {
          bash: {
            command: "test.echo",
            help: { summary: "Echo a value.", options: [] },
            parse: () => ({ value: "ok" }),
          },
        },
      }),
    ]);

    await expect(bash.exec("test.echo --format xml")).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "Unsupported --format value 'xml'\n",
    });
    expect(calls).toEqual([]);
  });

  test("rejects invalid parsed input before executing a runtime tool", async () => {
    const calls: unknown[] = [];
    const bash = createTestBash([
      defineBackofficeRuntimeTool({
        id: "test.echo",
        namespace: "test",
        name: "echo",
        description: "Echo a value.",
        requiredPermissions: [],
        inputSchema: z.object({ value: z.string().min(1) }),
        outputSchema: z.object({ value: z.string() }),
        execute: async (input) => {
          calls.push(input);
          return input;
        },
        adapters: {
          bash: {
            command: "test.echo",
            help: { summary: "Echo a value.", options: [] },
            parse: () => ({ value: "" }),
          },
        },
      }),
    ]);

    await expect(bash.exec("test.echo")).resolves.toMatchObject({ exitCode: 1, stdout: "" });
    expect(calls).toEqual([]);
  });

  test("rejects invalid runtime output before formatting command stdout", async () => {
    const bash = createTestBash([
      defineBackofficeRuntimeTool({
        id: "test.echo",
        namespace: "test",
        name: "echo",
        description: "Echo a value.",
        requiredPermissions: [],
        inputSchema: z.object({ value: z.string().min(1) }),
        outputSchema: z.object({ value: z.string().min(1) }),
        execute: async (input) => ({ ...input, value: "" }),
        adapters: {
          bash: {
            command: "test.echo",
            help: { summary: "Echo a value.", options: [] },
            parse: () => ({ value: "ok" }),
            format: (output) => ({ data: output }),
          },
        },
      }),
    ]);

    await expect(bash.exec("test.echo --print value")).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });
  });
});

const createBackofficeRuntime = (
  overrides: Partial<BackofficeCapabilitiesRuntime> = {},
): BackofficeCapabilitiesRuntime => ({
  listCapabilities: async () => [],
  listHookScopes: async () => [],
  listConnections: async () => [],
  getConnection: async () => ({ id: "mcp", label: "MCP", kind: "connection", configured: false }),
  setupConnection: async () => ({
    id: "mcp",
    label: "MCP",
    overview: "MCP setup",
    manualSteps: [],
    fields: [],
    configureExample: "connections.configure --id mcp --json '{}'",
  }),
  getConnectionSchema: async () => ({ id: "mcp", label: "MCP", fields: [] }),
  verifyConnection: async () => ({ id: "mcp", label: "MCP", kind: "connection", configured: true }),
  resetConnection: async () => ({ id: "mcp", label: "MCP", kind: "connection", configured: false }),
  configureConnection: async () => ({
    id: "mcp",
    label: "MCP",
    kind: "connection",
    configured: true,
  }),
  listAutomationEvents: async () => [],
  getAutomationEvent: async () => null,
  ...overrides,
});

const createTestBash = (tools: Parameters<typeof createBackofficeBashCommands>[0]["tools"]) =>
  new Bash({
    fs: new InMemoryFs(),
    customCommands: createBackofficeBashCommands({
      tools,
      context: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      commandCallsResult: [],
    }),
  });
