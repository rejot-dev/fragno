import { describe, expect, it } from "vitest";

import { Bash, InMemoryFs } from "just-bash";

import { createBashHost } from "../../bash-host";
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
  executeBashAutomation,
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
  bashEnv: {
    AUTOMATION_EVENT_ID: "test-event",
    AUTOMATION_ORG_ID: "org-ctx",
    AUTOMATION_SOURCE: "telegram",
    AUTOMATION_EVENT_TYPE: "message.received",
    AUTOMATION_OCCURRED_AT: "2026-01-01T00:00:00.000Z",
    AUTOMATION_SCRIPT_ID: "script-ctx",
    AUTOMATION_IDEMPOTENCY_KEY: "idempotency-ctx",
  },
  cloudflareEnv: {},
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
      bashEnv: {
        AUTOMATION_EVENT_ID: "event-shared",
        AUTOMATION_ORG_ID: "org-shared",
        AUTOMATION_SOURCE: "telegram",
        AUTOMATION_EVENT_TYPE: "message.received",
        AUTOMATION_OCCURRED_AT: "2026-01-01T00:00:00.000Z",
        AUTOMATION_SCRIPT_ID: "script-shared",
        AUTOMATION_IDEMPOTENCY_KEY: "idem-shared",
      },
      cloudflareEnv: {
        CF_TEST_NAMESPACE: "cf-value",
      },
    });

    let observedContext: {
      eventId: string;
      orgId?: string;
      idempotencyKey: string;
      binding: string;
      scriptId: string;
      bashEventId: string | undefined;
      cfEnvValue: string | undefined;
    } | null = null;

    const handlers: TestAutomationCommandHandlers = {
      "otp.identity.create-claim": async (_, commandContext) => {
        observedContext = {
          eventId: commandContext.event.id,
          orgId: commandContext.orgId,
          idempotencyKey: commandContext.idempotencyKey,
          binding: commandContext.binding.source,
          scriptId: commandContext.binding.scriptId,
          bashEventId: commandContext.bashEnv.AUTOMATION_EVENT_ID,
          cfEnvValue: commandContext.cloudflareEnv.CF_TEST_NAMESPACE,
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
      bashEventId: "event-shared",
      cfEnvValue: "cf-value",
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
      context: createAutomationBashCommandContext({
        event,
        binding: {
          source: "otp",
          eventType: "identity.claim.completed",
          scriptId: "script-otp-1",
        },
        idempotencyKey: "idempotency-otp-1",
        runtime: automationRuntime,
        sourceAdapter: getSourceAdapter(sourceAdapters, event.source),
        cloudflareEnv: {},
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

  it("projects canonical env vars and context files for automation runs", async () => {
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
      script: [
        'printf "env=%s\\n" "$AUTOMATION_EVENT_ID|$AUTOMATION_ORG_ID|$AUTOMATION_SOURCE|$AUTOMATION_EVENT_TYPE|$AUTOMATION_OCCURRED_AT|$AUTOMATION_ACTOR_TYPE|$AUTOMATION_EXTERNAL_ACTOR_ID|$AUTOMATION_SUBJECT_USER_ID|$AUTOMATION_SCRIPT_ID|$AUTOMATION_IDEMPOTENCY_KEY|$AUTOMATION_TELEGRAM_CHAT_ID|$AUTOMATION_TELEGRAM_TEXT"',
        'printf "event=%s\\n" "$(cat /context/event.json)"',
        'printf "payload=%s\\n" "$(cat /context/payload.json)"',
        'printf "actor=%s\\n" "$(cat /context/actor.json)"',
        'printf "subject=%s\\n" "$(cat /context/subject.json)"',
      ].join("\n"),
      context: createAutomationBashCommandContext({
        event,
        binding: {
          source: "telegram",
          eventType: "message.received",
          scriptId: "script-1",
        },
        idempotencyKey: "idempotency-1",
        runtime: automationRuntime,
        sourceAdapter: getSourceAdapter(sourceAdapters, event.source),
        cloudflareEnv: {},
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "env=event-123|org-1|telegram|message.received|2026-01-01T00:00:00.000Z|external|chat-1|user-1|script-1|idempotency-1|chat-1|/start",
      'event={"id":"event-123","orgId":"org-1","source":"telegram","eventType":"message.received","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"messageId":"message-1","chatId":"chat-1","fromUserId":"from-1","text":"/start"},"actor":{"type":"external","externalId":"chat-1"},"subject":{"userId":"user-1"}}',
      'payload={"messageId":"message-1","chatId":"chat-1","fromUserId":"from-1","text":"/start"}',
      'actor={"type":"external","externalId":"chat-1"}',
      'subject={"userId":"user-1"}',
    ]);
  });
});
