import { describe, expect, it } from "vitest";

import { Bash, InMemoryFs } from "just-bash";

import { createTelegramSourceAdapter } from "../../telegram";
import {
  createAutomationCommands,
  type AutomationCommandHandlers,
  type BashAutomationCommandResult,
} from "../command-spec";
import type { AutomationEvent } from "../contracts";
import { createBashAutomationEngine, type AutomationBashRuntime } from "./bash";

type TestContext = {
  invocation: string[];
};

const runtime: AutomationBashRuntime = {
  lookupBinding: async () => null,
  bindActor: async (input) => ({
    source: input.source,
    externalActorId: input.externalActorId,
    userId: input.userId,
    status: "linked",
  }),
  createClaim: async (input) => ({
    url: `https://example.com/${input.externalActorId}`,
    externalId: input.externalActorId,
    code: "123456",
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
    const context: TestContext = { invocation: [] };

    const handlers: AutomationCommandHandlers<TestContext> = {
      "identity.create-claim": async (command) => {
        context.invocation.push("create");
        return {
          data: {
            url: `https://example.com/${command.args.externalActorId}`,
            externalId: command.args.externalActorId,
            code: "123456",
          },
        };
      },
      "identity.lookup-binding": async (command) => {
        context.invocation.push("lookup");
        if (command.args.externalActorId === "missing") {
          return { exitCode: 1 };
        }
        return {
          data: {
            userId: `user-for-${command.args.externalActorId}`,
          },
        };
      },
      "identity.bind-actor": async (command) => {
        context.invocation.push("bind");
        return {
          data: {
            userId: command.args.userId,
            externalActorId: command.args.externalActorId,
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
      customCommands: createAutomationCommands(handlers, context, commandCallsResult),
    });

    const result = await bash.exec(
      'claim_url="$(identity.create-claim --source telegram --external-actor-id actor_1 --print url)"\n' +
        'linked_user="$(identity.lookup-binding --source telegram --external-actor-id actor_1 --print user-id)"\n' +
        'missing_user="$(identity.lookup-binding --source telegram --external-actor-id missing --print user-id || true)"\n' +
        'identity.bind-actor --source telegram --external-actor-id actor_1 --user-id "$linked_user" --format json\n' +
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
        command: "identity.create-claim",
        output: "https://example.com/actor_1",
        exitCode: 0,
      },
      {
        command: "identity.lookup-binding",
        output: "user-for-actor_1",
        exitCode: 0,
      },
      {
        command: "identity.lookup-binding",
        output: "",
        exitCode: 1,
      },
      {
        command: "identity.bind-actor",
        output: '{"userId":"user-for-actor_1","externalActorId":"actor_1"}',
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

  it("can reply through an overridden source adapter", async () => {
    const replyCalls: Array<{ externalActorId: string; text: string }> = [];
    const engine = createBashAutomationEngine({
      sourceAdapters: {
        telegram: createTelegramSourceAdapter({
          reply: async ({ externalActorId, text }) => {
            replyCalls.push({ externalActorId, text });
          },
        }),
      },
    });

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

    const result = await engine.execute({
      event,
      binding: {
        source: "otp",
        eventType: "identity.claim.completed",
        scriptId: "script-otp-1",
      },
      idempotencyKey: "idempotency-otp-1",
      runtime,
      script: 'event.reply --source telegram --external-actor-id chat-1 --text "linked"',
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
    const engine = createBashAutomationEngine({
      sourceAdapters: {
        telegram: createTelegramSourceAdapter(),
      },
    });

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

    const result = await engine.execute({
      event,
      binding: {
        source: "telegram",
        eventType: "message.received",
        scriptId: "script-1",
      },
      idempotencyKey: "idempotency-1",
      runtime,
      script: [
        'printf "env=%s\\n" "$AUTOMATION_EVENT_ID|$AUTOMATION_ORG_ID|$AUTOMATION_SOURCE|$AUTOMATION_EVENT_TYPE|$AUTOMATION_OCCURRED_AT|$AUTOMATION_ACTOR_TYPE|$AUTOMATION_EXTERNAL_ACTOR_ID|$AUTOMATION_SUBJECT_USER_ID|$AUTOMATION_SCRIPT_ID|$AUTOMATION_IDEMPOTENCY_KEY|$AUTOMATION_TELEGRAM_CHAT_ID|$AUTOMATION_TELEGRAM_TEXT"',
        'printf "event=%s\\n" "$(cat /context/event.json)"',
        'printf "payload=%s\\n" "$(cat /context/payload.json)"',
        'printf "actor=%s\\n" "$(cat /context/actor.json)"',
        'printf "subject=%s\\n" "$(cat /context/subject.json)"',
      ].join("\n"),
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
