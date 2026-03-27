import { describe, expect, it } from "vitest";

import { Bash, InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";

import { createBashHost, executeBashAutomation } from "../../bash-runtime/bash-host";
import { createTelegramSourceAdapter } from "../../telegram";
import { createAutomationCommands } from "../commands/bash-adapter";
import {
  AUTOMATIONS_COMMAND_SPEC_LIST,
  EVENT_COMMAND_SPEC_LIST,
  OTP_COMMAND_SPEC_LIST,
} from "../commands/registry";
import type {
  AutomationCommandContext,
  AutomationsCommandHandlers,
  BashAutomationCommandResult,
  EventCommandHandlers,
  OtpCommandHandlers,
} from "../commands/types";
import { getSourceAdapter, type AutomationEvent } from "../contracts";
import {
  createAutomationBashCommandContext,
  createAutomationBashRuntime,
  type AutomationBashRuntime,
} from "./bash";

type TestContext = {
  invocation: string[];
} & AutomationCommandContext;

type TestAutomationCommandHandlers = AutomationsCommandHandlers<TestContext> &
  OtpCommandHandlers<TestContext> &
  EventCommandHandlers<TestContext>;

const TEST_COMMAND_SPEC_LIST = [
  ...AUTOMATIONS_COMMAND_SPEC_LIST,
  ...OTP_COMMAND_SPEC_LIST,
  ...EVENT_COMMAND_SPEC_LIST,
] as const;

const createTestCommandContext = (overrides: Partial<TestContext> = {}): TestContext => ({
  invocation: [],
  event: {
    id: "test-event",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
  },
  binding: {
    source: "telegram",
    eventType: "message.received",
    scriptId: "script-ctx",
  },
  orgId: "org-ctx",
  idempotencyKey: "idempotency-ctx",
  bashEnv: {},
  ...overrides,
});

const runtime: AutomationBashRuntime = {
  lookupBinding: async () => null,
  bindActor: async (input) => ({
    source: input.source,
    key: input.key,
    value: input.value,
    status: "linked",
  }),
  createClaim: async (input) => ({
    url: `https://example.com/${input.externalActorId}`,
    externalId: input.externalActorId,
    code: "123456",
  }),
  reply: async () => ({
    ok: true,
  }),
  emitEvent: async (input) => ({
    accepted: true,
    eventId: "emitted-1",
    orgId: undefined,
    source: input.source ?? "otp",
    eventType: input.eventType,
  }),
};

describe("bash command runner", () => {
  it("runs cli-style automation commands through just-bash", async () => {
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const context = createTestCommandContext();

    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async (command) => {
        context.invocation.push("create");
        return {
          data: {
            url: `https://example.com/${command.args.externalActorId}`,
            externalId: command.args.externalActorId,
            code: "123456",
          },
        };
      },
      "automations.identity.lookup-binding": async (command) => {
        context.invocation.push("lookup");
        if (command.args.key === "missing") {
          return { exitCode: 1 };
        }
        return {
          data: {
            value: `user-for-${command.args.key}`,
          },
        };
      },
      "automations.identity.bind-actor": async (command) => {
        context.invocation.push("bind");
        return {
          data: {
            value: command.args.value,
            key: command.args.key,
          },
        };
      },
      "event.reply": async (command) => {
        context.invocation.push(
          `reply:${command.args.source ?? ""}:${command.args.externalActorId ?? ""}`,
        );
        return {
          data: {
            text: command.args.text,
          },
        };
      },
      "event.emit": async (command) => {
        context.invocation.push("emit");
        return {
          data: {
            eventType: command.args.eventType,
            source: command.args.source ?? "otp",
          },
        };
      },
      "automations.script.run": async () => {
        throw new Error("not available in test");
      },
    };

    const fs = new InMemoryFs();
    const bash = new Bash({
      fs,
      customCommands: createAutomationCommands(
        TEST_COMMAND_SPEC_LIST,
        handlers,
        context,
        commandCallsResult,
      ),
    });

    const result = await bash.exec(
      'claim_url="$(otp.identity.create-claim --source telegram --external-actor-id actor_1 --print url)"\n' +
        'linked_user="$(automations.identity.lookup-binding --source telegram --key actor_1 --print value)"\n' +
        'missing_user="$(automations.identity.lookup-binding --source telegram --key missing --print value || true)"\n' +
        'automations.identity.bind-actor --source telegram --key actor_1 --value "$linked_user" --format json\n' +
        'event.reply --source telegram --external-actor-id actor_2 --text "done"\n' +
        "event.emit --event-type identity.binding.completed --source otp --format json\n" +
        'echo "$claim_url|$linked_user|$missing_user"',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim().split("\n").at(-1)).toBe(
      "https://example.com/actor_1|user-for-actor_1|",
    );
    expect(context.invocation).toEqual([
      "create",
      "lookup",
      "lookup",
      "bind",
      "reply:telegram:actor_2",
      "emit",
    ]);
    expect(commandCallsResult).toEqual([
      {
        command: "otp.identity.create-claim",
        output: "https://example.com/actor_1",
        exitCode: 0,
      },
      {
        command: "automations.identity.lookup-binding",
        output: "user-for-actor_1",
        exitCode: 0,
      },
      {
        command: "automations.identity.lookup-binding",
        output: "",
        exitCode: 1,
      },
      {
        command: "automations.identity.bind-actor",
        output: '{"value":"user-for-actor_1","key":"actor_1"}',
        exitCode: 0,
      },
      {
        command: "event.reply",
        output: "",
        exitCode: 0,
      },
      {
        command: "event.emit",
        output: '{"eventType":"identity.binding.completed","source":"otp"}',
        exitCode: 0,
      },
    ]);
  });

  it("shows command-line help for automation commands", async () => {
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const context = createTestCommandContext();
    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async () => {
        return {
          data: {
            url: "https://example.com/help",
            externalId: "external-id",
            code: "help",
          },
        };
      },
      "automations.identity.lookup-binding": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
        },
      }),
      "automations.identity.bind-actor": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
          key: "external-id",
          status: "linked",
        },
      }),
      "event.reply": async () => ({
        data: {
          ok: true,
        },
      }),
      "event.emit": async () => ({
        data: {
          accepted: true,
          eventId: "help-event",
          source: "telegram",
          eventType: "help-event",
        },
      }),
      "automations.script.run": async () => {
        throw new Error("not available in test");
      },
    };

    const bash = new Bash({
      customCommands: createAutomationCommands(
        TEST_COMMAND_SPEC_LIST,
        handlers,
        context,
        commandCallsResult,
      ),
    });

    const result = await bash.exec("otp.identity.create-claim --help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("otp.identity.create-claim");
    expect(result.stdout).toContain("--source");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("--print <selector>");
    expect(result.stdout).toContain("--format <format>");
    expect(context.invocation).toEqual([]);
    expect(commandCallsResult).toEqual([
      {
        command: "otp.identity.create-claim",
        output: expect.any(String),
        exitCode: 0,
      },
    ]);
  });

  it("shows command-line help for all built-in automation commands", async () => {
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const context = createTestCommandContext();
    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async () => ({
        data: { url: "https://example.com", externalId: "external-id", code: "123456" },
      }),
      "automations.identity.lookup-binding": async () => ({
        data: { value: "help-user", source: "telegram" },
      }),
      "automations.identity.bind-actor": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
          key: "external-id",
          status: "linked",
        },
      }),
      "event.reply": async () => ({ data: { ok: true } }),
      "event.emit": async () => ({
        data: {
          accepted: true,
          eventId: "help-event",
          source: "telegram",
          eventType: "help-event",
        },
      }),
      "automations.script.run": async () => {
        throw new Error("not available in test");
      },
    };

    const bash = new Bash({
      customCommands: createAutomationCommands(
        TEST_COMMAND_SPEC_LIST,
        handlers,
        context,
        commandCallsResult,
      ),
    });

    const helpResults = [
      await bash.exec("otp.identity.create-claim --help"),
      await bash.exec("automations.identity.lookup-binding --help"),
      await bash.exec("automations.identity.bind-actor --help"),
      await bash.exec("event.reply --help"),
      await bash.exec("event.emit --help"),
    ];

    expect(helpResults.every((result) => result.exitCode === 0)).toBe(true);
    for (const result of helpResults) {
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("--help");
      expect(result.stdout).toContain("--print <selector>");
      expect(result.stdout).toContain("--format <format>");
    }
    expect(context.invocation).toEqual([]);
    expect(commandCallsResult).toEqual([
      {
        command: "otp.identity.create-claim",
        output: expect.stringContaining("otp.identity.create-claim"),
        exitCode: 0,
      },
      {
        command: "automations.identity.lookup-binding",
        output: expect.stringContaining("automations.identity.lookup-binding"),
        exitCode: 0,
      },
      {
        command: "automations.identity.bind-actor",
        output: expect.stringContaining("automations.identity.bind-actor"),
        exitCode: 0,
      },
      {
        command: "event.reply",
        output: expect.stringContaining("event.reply"),
        exitCode: 0,
      },
      {
        command: "event.emit",
        output: expect.stringContaining("event.emit"),
        exitCode: 0,
      },
    ]);
  });

  it("returns a parse error when required command args are missing", async () => {
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const context = createTestCommandContext();
    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async () => {
        return {
          data: {
            url: "https://example.com/claims",
            externalId: "should-not-call",
            code: "000000",
          },
        };
      },
      "automations.identity.lookup-binding": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
        },
      }),
      "automations.identity.bind-actor": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
          key: "external-id",
          status: "linked",
        },
      }),
      "event.reply": async () => ({
        data: {
          ok: true,
        },
      }),
      "event.emit": async () => ({
        data: {
          accepted: true,
          eventId: "help-event",
          source: "telegram",
          eventType: "help-event",
        },
      }),
      "automations.script.run": async () => {
        throw new Error("not available in test");
      },
    };

    const bash = new Bash({
      customCommands: createAutomationCommands(
        TEST_COMMAND_SPEC_LIST,
        handlers,
        context,
        commandCallsResult,
      ),
    });

    const result = await bash.exec("otp.identity.create-claim --external-actor-id actor_1");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required option --source");
    expect(context.invocation).toEqual([]);
    expect(commandCallsResult).toEqual([
      {
        command: "otp.identity.create-claim",
        output: "",
        exitCode: 1,
      },
    ]);
  });

  it("returns a parse error when ttl-minutes is not a positive integer", async () => {
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const context = createTestCommandContext();
    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async () => {
        return {
          data: {
            url: "https://example.com/claims",
            externalId: "should-not-call",
            code: "000000",
          },
        };
      },
      "automations.identity.lookup-binding": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
        },
      }),
      "automations.identity.bind-actor": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
          key: "external-id",
          status: "linked",
        },
      }),
      "event.reply": async () => ({
        data: {
          ok: true,
        },
      }),
      "event.emit": async () => ({
        data: {
          accepted: true,
          eventId: "help-event",
          source: "telegram",
          eventType: "help-event",
        },
      }),
      "automations.script.run": async () => {
        throw new Error("not available in test");
      },
    };

    const bash = new Bash({
      customCommands: createAutomationCommands(
        TEST_COMMAND_SPEC_LIST,
        handlers,
        context,
        commandCallsResult,
      ),
    });

    const result = await bash.exec(
      "otp.identity.create-claim --source telegram --external-actor-id actor_1 --ttl-minutes 0",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--ttl-minutes must be a positive integer");
    expect(context.invocation).toEqual([]);
    expect(commandCallsResult).toEqual([
      {
        command: "otp.identity.create-claim",
        output: "",
        exitCode: 1,
      },
    ]);
  });

  it("omits pi.session commands from automation bash hosts", async () => {
    const context = createTestCommandContext();
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: {
          ...context,
          runtime: {
            reply: async () => ({ ok: true as const }),
            emitEvent: runtime.emitEvent,
          },
        },
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
        },
        otp: {
          runtime: {
            createClaim: runtime.createClaim,
          },
        },
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec("pi.session.get --session-id session-1");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("bash: pi.session.get: command not found");
    expect(commandCallsResult).toEqual([]);
  });

  it("passes shared automation command context through handler execution", async () => {
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const context = createTestCommandContext({
      idempotencyKey: "idem-shared",
      orgId: "org-shared",
      event: {
        id: "event-shared",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        orgId: "org-shared",
        payload: {
          subject: "context-test",
        },
      },
      binding: {
        source: "telegram",
        eventType: "message.received",
        scriptId: "script-shared",
      },
      bashEnv: {},
    });

    let observedContext: {
      eventId: string;
      orgId?: string;
      idempotencyKey: string;
      binding: string;
      scriptId: string;
    } | null = null;

    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async (_, commandContext) => {
        observedContext = {
          eventId: commandContext.event.id,
          orgId: commandContext.orgId,
          idempotencyKey: commandContext.idempotencyKey,
          binding: commandContext.binding.source,
          scriptId: commandContext.binding.scriptId,
        };

        return {
          data: {
            url: `https://example.com/${commandContext.binding.source}`,
            externalId: "external-id",
            code: "123456",
          },
        };
      },
      "automations.identity.lookup-binding": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
        },
      }),
      "automations.identity.bind-actor": async () => ({
        data: {
          value: "help-user",
          source: "telegram",
          key: "external-id",
          status: "linked",
        },
      }),
      "event.reply": async () => ({
        data: {
          ok: true,
        },
      }),
      "event.emit": async () => ({
        data: {
          accepted: true,
          eventId: "event-ctx",
          source: "telegram",
          eventType: "message.received",
        },
      }),
      "automations.script.run": async () => {
        throw new Error("not available in test");
      },
    };

    const bash = new Bash({
      customCommands: createAutomationCommands(
        TEST_COMMAND_SPEC_LIST,
        handlers,
        context,
        commandCallsResult,
      ),
    });

    const result = await bash.exec(
      "otp.identity.create-claim --source telegram --external-actor-id external-id",
    );

    expect(result.exitCode).toBe(0);
    expect(observedContext).toEqual({
      eventId: "event-shared",
      orgId: "org-shared",
      idempotencyKey: "idem-shared",
      binding: "telegram",
      scriptId: "script-shared",
    });
    expect(commandCallsResult).toEqual([
      {
        command: "otp.identity.create-claim",
        output: "",
        exitCode: 0,
      },
    ]);
  });

  it("can reply through an overridden source adapter", async () => {
    const replyCalls: Array<{ externalActorId: string; text: string }> = [];
    const sourceAdapters = {
      telegram: createTelegramSourceAdapter({
        reply: async ({ externalActorId, text }) => {
          replyCalls.push({ externalActorId, text });
        },
      }),
    };

    const event: AutomationEvent = {
      id: "event-otp-1",
      orgId: "org-1",
      source: "otp",
      eventType: "identity.claim.completed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        linkSource: "telegram",
        externalActorId: "chat-1",
      },
      actor: null,
      subject: {
        userId: "user-1",
      },
    };

    const automationRuntime = createAutomationBashRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event,
      sourceAdapters,
      sourceAdapter: getSourceAdapter(sourceAdapters, event.source),
    });
    const result = await executeBashAutomation({
      script: 'event.reply --source telegram --external-actor-id chat-1 --text "linked"',
      masterFs: new MasterFileSystem({ mounts: [] }),
      context: createAutomationBashCommandContext({
        event,
        binding: {
          source: "otp",
          eventType: "identity.claim.completed",
          scriptId: "script-otp-1",
        },
        idempotencyKey: "idempotency-otp-1",
        runtime: automationRuntime,
        pi: {
          runtime: {
            createSession: async () => {
              throw new Error("pi automation context not configured for this test");
            },
            getSession: async () => {
              throw new Error("pi automation context not configured for this test");
            },
            listSessions: async () => {
              throw new Error("pi automation context not configured for this test");
            },
            runTurn: async () => {
              throw new Error("pi automation context not configured for this test");
            },
          },
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(replyCalls).toEqual([
      {
        externalActorId: "chat-1",
        text: "linked",
      },
    ]);
  });

  it("forwards sub-script stdout through automations.script.run", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
          scriptRunner: {
            runScript: async (args) => {
              expect(args).toEqual({
                script: "/automations/test.sh",
                event: "/events/2026-03-26/evt-1.json",
              });
              return {
                eventId: "evt-1",
                scriptId: "manual:/automations/test.sh",
                exitCode: 0,
                stdout: "hello from sub-script\n",
                stderr: "",
                commandCalls: [],
              };
            },
          },
        },
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec(
      "automations.script.run --script /automations/test.sh --event /events/2026-03-26/evt-1.json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from sub-script");
    expect(commandCallsResult).toEqual([
      {
        command: "automations.script.run",
        output: "hello from sub-script",
        exitCode: 0,
      },
    ]);
  });

  it("returns structured data with --format json for automations.script.run", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
          scriptRunner: {
            runScript: async () => ({
              eventId: "evt-1",
              scriptId: "manual:/automations/test.sh",
              exitCode: 0,
              stdout: "echoed output\n",
              stderr: "",
              commandCalls: [{ command: "event.reply", output: "", exitCode: 0 }],
            }),
          },
        },
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec(
      "automations.script.run --script /automations/test.sh --event /events/2026-03-26/evt-1.json --format json",
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout!.trim());
    expect(parsed).toEqual({
      exitCode: 0,
      stdout: "echoed output\n",
      stderr: "",
      commandCalls: [{ command: "event.reply", output: "", exitCode: 0 }],
    });
  });

  it("forwards stderr and exit code for failed sub-scripts", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: {
            lookupBinding: runtime.lookupBinding,
            bindActor: runtime.bindActor,
          },
          scriptRunner: {
            runScript: async () => ({
              eventId: "evt-1",
              scriptId: "manual:/automations/fail.sh",
              exitCode: 1,
              stdout: "partial output\n",
              stderr: "something went wrong\n",
              commandCalls: [],
            }),
          },
        },
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec(
      "automations.script.run --script /automations/fail.sh --event /events/2026-03-26/evt-1.json",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("partial output");
    expect(result.stderr).toContain("something went wrong");
  });

  it("provides /context/event.json for automation runs", async () => {
    const sourceAdapters = {
      telegram: createTelegramSourceAdapter(),
    };

    const event: AutomationEvent = {
      id: "event-123",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        messageId: "message-1",
        chatId: "chat-1",
        fromUserId: "from-1",
        text: "/start",
      },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
      subject: {
        userId: "user-1",
      },
    };

    const automationRuntime = createAutomationBashRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event,
      sourceAdapters,
      sourceAdapter: getSourceAdapter(sourceAdapters, event.source),
    });
    const result = await executeBashAutomation({
      script: 'printf "event=%s\\n" "$(cat /context/event.json)"',
      masterFs: new MasterFileSystem({ mounts: [] }),
      context: createAutomationBashCommandContext({
        event,
        binding: {
          source: "telegram",
          eventType: "message.received",
          scriptId: "script-1",
        },
        idempotencyKey: "idempotency-1",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'event={"id":"event-123","orgId":"org-1","source":"telegram","eventType":"message.received","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"messageId":"message-1","chatId":"chat-1","fromUserId":"from-1","text":"/start"},"actor":{"type":"external","externalId":"chat-1"},"subject":{"userId":"user-1"}}',
    );
  });

  it("mounts /dev/null so scripts can discard output", async () => {
    const automationRuntime = createAutomationBashRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event: {
        id: "dev-null-event",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
      sourceAdapters: { telegram: createTelegramSourceAdapter() },
      sourceAdapter: createTelegramSourceAdapter(),
    });

    const result = await executeBashAutomation({
      script: 'echo "discarded" >/dev/null && echo "kept"',
      masterFs: new MasterFileSystem({ mounts: [] }),
      context: createAutomationBashCommandContext({
        event: {
          id: "dev-null-event",
          source: "telegram",
          eventType: "message.received",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
        },
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-dev" },
        idempotencyKey: "idem-dev",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("kept");
  });

  it("unmounts /context and /dev after execution", async () => {
    const masterFs = new MasterFileSystem({ mounts: [] });

    const automationRuntime = createAutomationBashRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event: {
        id: "cleanup-event",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
      sourceAdapters: { telegram: createTelegramSourceAdapter() },
      sourceAdapter: createTelegramSourceAdapter(),
    });

    await executeBashAutomation({
      script: "echo ok",
      masterFs,
      context: createAutomationBashCommandContext({
        event: {
          id: "cleanup-event",
          source: "telegram",
          eventType: "message.received",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
        },
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-cleanup" },
        idempotencyKey: "idem-cleanup",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(masterFs.mounts).toHaveLength(0);
  });

  it("skips /dev mount when one already exists on the master filesystem", async () => {
    const masterFs = new MasterFileSystem({ mounts: [] });
    masterFs.mount({
      id: "existing-dev",
      kind: "custom",
      mountPoint: "/dev",
      title: "Existing /dev",
      readOnly: false,
      persistence: "session",
      fs: normalizeMountedFileSystem(
        {
          readFile: async () => "",
          readdir: async () => [],
          getAllPaths: () => ["/dev"],
        },
        { readOnly: false },
      ),
    });

    const automationRuntime = createAutomationBashRuntime({
      hookContext: {
        handlerTx: (() => {
          throw new Error("handlerTx should not be used in this test");
        }) as never,
      },
      event: {
        id: "existing-dev-event",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
      sourceAdapters: { telegram: createTelegramSourceAdapter() },
      sourceAdapter: createTelegramSourceAdapter(),
    });

    await executeBashAutomation({
      script: "echo ok",
      masterFs,
      context: createAutomationBashCommandContext({
        event: {
          id: "existing-dev-event",
          source: "telegram",
          eventType: "message.received",
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: {},
        },
        binding: { source: "telegram", eventType: "message.received", scriptId: "s-edev" },
        idempotencyKey: "idem-edev",
        runtime: automationRuntime,
        pi: null,
      }),
    });

    expect(masterFs.mounts).toHaveLength(1);
    expect(masterFs.mounts[0]!.id).toBe("existing-dev");
  });
});
