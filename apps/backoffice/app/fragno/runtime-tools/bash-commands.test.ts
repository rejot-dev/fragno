import { describe, expect, test } from "vitest";

import { Bash, InMemoryFs } from "just-bash";
import { z } from "zod";

import type { AutomationsRuntime } from "./families/automations";
import { automationIdentityRuntimeTools } from "./families/automations";
import { eventRuntimeTools, type EventRuntime } from "./families/event";
import { createBackofficeBashCommands } from "./runtime-tools";
import { defineBackofficeRuntimeTool } from "./runtime-tools";

describe("createBackofficeBashCommands", () => {
  test("routes generated bash commands through semantic runtime tools", async () => {
    const calls: unknown[] = [];
    const commandCallsResult: { command: string; output: string; exitCode: number }[] = [];
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

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: automationIdentityRuntimeTools,
        context: { runtimes: { automations: automationsRuntime } },
        commandCallsResult,
      }),
    });

    await expect(
      bash.exec(
        "automations.identity.lookup-binding --source telegram --key chat-123 --print value",
      ),
    ).resolves.toMatchObject({ stdout: "user-55\n", exitCode: 0 });

    await expect(
      bash.exec(
        "automations.identity.bind-actor --source telegram --key chat-123 --value user-55 --format json",
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(calls).toEqual([
      ["lookupBinding", { source: "telegram", key: "chat-123" }],
      ["bindActor", { source: "telegram", key: "chat-123", value: "user-55" }],
    ]);
    expect(commandCallsResult.map((call) => call.command)).toEqual([
      "automations.identity.lookup-binding",
      "automations.identity.bind-actor",
    ]);
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
          orgId: "org-1",
          source: input.source ?? "telegram",
          eventType: input.eventType,
        };
      },
    };

    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: eventRuntimeTools,
        context: { runtimes: { event: eventRuntime } },
        commandCallsResult,
      }),
    });

    await expect(
      bash.exec(
        'event.emit --event-type identity.bound --source otp --payload-json \'{"plan":"basic"}\' --print eventId',
      ),
    ).resolves.toMatchObject({ stdout: "event-2\n", exitCode: 0 });

    expect(calls).toEqual([
      ["emitEvent", { eventType: "identity.bound", source: "otp", payload: { plan: "basic" } }],
    ]);
    expect(commandCallsResult).toEqual([{ command: "event.emit", output: "event-2", exitCode: 0 }]);
  });

  test("rejects invalid output options before executing a runtime tool", async () => {
    const calls: unknown[] = [];
    const bash = createTestBash([
      defineBackofficeRuntimeTool({
        id: "test.echo",
        namespace: "test",
        name: "echo",
        description: "Echo a value.",
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

const createTestBash = (tools: Parameters<typeof createBackofficeBashCommands>[0]["tools"]) =>
  new Bash({
    fs: new InMemoryFs(),
    customCommands: createBackofficeBashCommands({
      tools,
      context: { runtimes: {} },
      commandCallsResult: [],
    }),
  });
