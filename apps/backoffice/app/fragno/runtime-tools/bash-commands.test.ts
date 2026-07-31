import { describe, expect, test } from "vitest";

import { Bash, InMemoryFs } from "just-bash";
import { z } from "zod";

import type { RegisteredAutomationsRuntime } from "./bash-host";
import { automationStoreRuntimeTools } from "./families/automations-bindings";
import { createUnavailableAutomationRouterRuntime } from "./families/automations-routing";
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
      bash.exec("store.set --key telegram/chat-123 --value user-55 --format json"),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      bash.exec("store.delete --key telegram/chat-123 --format json"),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      bash.exec("store.list --prefix telegram/ --limit 10 --format json"),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(calls).toEqual([
      ["get", { key: "telegram/chat-123" }],
      ["set", { key: "telegram/chat-123", value: "user-55" }],
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

  test("accepts store.set without caller-authored provenance", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: RegisteredAutomationsRuntime = {
      ...createUnavailableAutomationRouterRuntime(),
      get: async () => null,
      set: async (input) => {
        calls.push(["set", input]);
        return { id: input.key, key: input.key, value: input.value, category: [] };
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
      bash.exec("store.set --key dashboard/example --value configured --format json"),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["set", { key: "dashboard/example", value: "configured" }]]);
  });

  test.each([
    "actor",
    "actors",
    "principal",
    "execution-context",
    "propagation-context",
    "permissions",
  ])("rejects caller-supplied --%s metadata", async (optionName) => {
    const automationsRuntime: RegisteredAutomationsRuntime = {
      ...createUnavailableAutomationRouterRuntime(),
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
      bash.exec(`store.set --key dashboard/example --value configured --${optionName} '{}'`),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(`does not accept option --${optionName}`),
    });
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
        'events.fire --event-type identity.bound --source otp --payload-json \'{"plan":"basic"}\' --target-scope-json \'{"kind":"org","orgId":"org-2"}\' --print eventId',
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
    expect(commandCallsResult).toEqual([
      { command: "events.fire", output: "event-2", exitCode: 0 },
    ]);
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
        'events.fire --event-type identity.bound --target-scope-json \'{"kind":"org","orgId":""}\'',
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

  test("passes events.catalog.create --json as the event definition", async () => {
    const calls: unknown[] = [];
    const backofficeRuntime = createBackofficeRuntime({
      createAutomationEvent: async (input) => {
        calls.push(["createAutomationEvent", input]);
        return {
          id: `${input.source}:${input.eventType}`,
          source: input.source,
          eventType: input.eventType,
          label: input.label,
          description: input.description ?? null,
          payloadSchema: input.payloadSchema ?? null,
          actorSchema: input.actorSchema ?? null,
          subjectSchema: input.subjectSchema ?? null,
          example: input.example ?? null,
          enabled: input.enabled ?? true,
          capabilityId: "dynamic",
        };
      },
    });

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: eventRuntimeTools,
        context: createTrustedSystemBackofficeToolContext({
          runtimes: { backoffice: backofficeRuntime },
        }),
        commandCallsResult: [],
      }),
    });

    await expect(
      bash.exec(
        `events.catalog.create --json '{"source":"custom","eventType":"thing.created","label":"Thing created"}'`,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(calls).toEqual([
      [
        "createAutomationEvent",
        { source: "custom", eventType: "thing.created", label: "Thing created", enabled: true },
      ],
    ]);
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
  verifyConnection: async () => ({
    id: "mcp",
    label: "MCP",
    kind: "connection",
    configured: true,
    verification: { ok: true, message: "MCP configuration is present." },
  }),
  resetConnection: async () => ({ id: "mcp", label: "MCP", kind: "connection", configured: false }),
  configureConnection: async () => ({
    id: "mcp",
    label: "MCP",
    kind: "connection",
    configured: true,
  }),
  listAutomationEvents: async () => [],
  getAutomationEvent: async () => null,
  createAutomationEvent: async (input) => ({
    id: `${input.source}:${input.eventType}`,
    source: input.source,
    eventType: input.eventType,
    label: input.label,
    description: input.description ?? null,
    payloadSchema: input.payloadSchema ?? null,
    actorSchema: input.actorSchema ?? null,
    subjectSchema: input.subjectSchema ?? null,
    example: input.example ?? null,
    enabled: input.enabled ?? true,
    capabilityId: "dynamic",
  }),
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
