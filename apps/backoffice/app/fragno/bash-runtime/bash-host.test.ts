import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "./bash-host";

const createAutomationsRuntime = () => ({
  lookupBinding: async () => ({
    source: "telegram",
    key: "actor-1",
    value: "user-1",
    status: "linked",
  }),
  bindActor: async ({ source, key, value }: Record<string, string>) => ({
    source,
    key,
    value,
    status: "linked",
  }),
});

const createOtpRuntime = () => ({
  createClaim: async ({ source, externalActorId }: Record<string, string>) => ({
    url: `https://example.com/${source}/${externalActorId}`,
    externalId: externalActorId,
    code: "123456",
  }),
});

const createResendRuntime = () => ({
  listThreads: async () => ({
    threads: [],
    hasNextPage: false,
  }),
  getThread: async ({ threadId }: { threadId: string }) => ({
    id: threadId,
    subject: "Invoice Update",
    normalizedSubject: "invoice update",
    participants: ["customer@example.com", "support@example.com"],
    messageCount: 1,
    firstMessageAt: new Date("2026-01-01T00:00:00.000Z"),
    lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
    lastDirection: "outbound",
    lastMessagePreview: "Hello there",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    replyToAddress: "reply@example.com",
  }),
  listThreadMessages: async () => ({
    messages: [],
    hasNextPage: false,
  }),
  getThreadSnapshot: async ({ threadId }: { threadId: string }) => ({
    thread: {
      id: threadId,
      subject: "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageCount: 1,
      firstMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      lastDirection: "outbound",
      lastMessagePreview: "Hello there",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      replyToAddress: "reply@example.com",
    },
    messages: [],
    hasNextPage: false,
    markdown: "# Invoice Update\n",
  }),
  replyToThread: async ({
    threadId,
    subject,
    body,
  }: {
    threadId: string;
    subject?: string;
    body: string;
  }) => ({
    thread: {
      id: threadId,
      subject: subject ?? "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageCount: 2,
      firstMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      lastDirection: "outbound",
      lastMessagePreview: body,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      replyToAddress: "reply@example.com",
    },
    message: {
      id: "reply-1",
      threadId,
      direction: "outbound",
      status: "queued",
      from: "support@example.com",
      to: ["customer@example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: subject ?? "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageId: null,
      inReplyTo: null,
      references: [],
      providerEmailId: null,
      attachments: [],
      html: null,
      text: body,
      headers: null,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      scheduledAt: null,
      sentAt: null,
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  }),
});

const createPiRuntime = () => ({
  createSession: async () => ({
    id: "session-1",
    agent: "assistant",
    status: "waiting",
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  getSession: async ({ sessionId }: { sessionId: string }) => ({
    id: sessionId,
    agent: "assistant",
    status: "waiting",
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workflow: { status: "waiting" },
    messages: [],
    events: [],
    trace: [],
    summaries: [],
    turn: 0,
    phase: "waiting-for-user",
    waitingFor: null,
  }),
  listSessions: async () =>
    Promise.resolve([
      {
        id: "session-1",
        name: null,
        status: "waiting",
        agent: "assistant",
        steeringMode: "one-at-a-time",
        metadata: null,
        tags: [],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]),
  runTurn: async ({ sessionId, text }: { sessionId: string; text: string }) => ({
    id: sessionId,
    agent: "assistant",
    status: "waiting",
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workflow: { status: "waiting" as const },
    messages: [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      },
    ],
    events: [],
    trace: [],
    summaries: [],
    turn: 0,
    phase: "waiting-for-user" as const,
    waitingFor: null,
    assistantText: text,
    messageStatus: "active" as const,
    stream: [
      {
        layer: "system" as const,
        type: "settled" as const,
        turn: 0,
        status: "waiting-for-user" as const,
      },
    ],
    terminalFrame: {
      layer: "system" as const,
      type: "settled" as const,
      turn: 0,
      status: "waiting-for-user" as const,
    },
  }),
});

const createAutomationContext = () => ({
  event: {
    id: "event-1",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
  },
  orgId: "org-1",
  binding: {
    source: "telegram",
    eventType: "message.received",
    scriptId: "script-1",
  },
  idempotencyKey: "idem-1",
  bashEnv: {
    AUTOMATION_EVENT_ID: "event-1",
    AUTOMATION_ORG_ID: "org-1",
    AUTOMATION_SOURCE: "telegram",
    AUTOMATION_EVENT_TYPE: "message.received",
    AUTOMATION_OCCURRED_AT: "2026-01-01T00:00:00.000Z",
    AUTOMATION_SCRIPT_ID: "script-1",
    AUTOMATION_IDEMPOTENCY_KEY: "idem-1",
  },
  runtime: {
    reply: async () => ({ ok: true as const }),
    emitEvent: async ({ eventType, source }: { eventType: string; source?: string }) => ({
      accepted: true,
      eventId: "emitted-1",
      orgId: "org-1",
      source: source ?? "telegram",
      eventType,
    }),
  },
});

describe("bash host command assembly", () => {
  it("loads pi, automations, otp, and resend command families without exposing automation event commands", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        pi: {
          runtime: createPiRuntime(),
        },
        automations: {
          runtime: createAutomationsRuntime(),
        },
        otp: {
          runtime: createOtpRuntime(),
        },
        resend: {
          runtime: createResendRuntime(),
        },
      },
    });

    const piHelp = await bash.exec("pi.session.get --help");
    const automationsHelp = await bash.exec("automations.identity.lookup-binding --help");
    const otpHelp = await bash.exec("otp.identity.create-claim --help");
    const resendGetHelp = await bash.exec("resend.threads.get --help");
    const resendListHelp = await bash.exec("resend.threads.list --help");
    const resendReplyHelp = await bash.exec("resend.threads.reply --help");
    const missingEvent = await bash.exec("event.emit --event-type test");

    expect(piHelp.exitCode).toBe(0);
    expect(piHelp.stdout).toContain("pi.session.get");
    expect(automationsHelp.exitCode).toBe(0);
    expect(automationsHelp.stdout).toContain("automations.identity.lookup-binding");
    expect(otpHelp.exitCode).toBe(0);
    expect(otpHelp.stdout).toContain("otp.identity.create-claim");
    expect(resendGetHelp.exitCode).toBe(0);
    expect(resendGetHelp.stdout).toContain("resend.threads.get");
    expect(resendListHelp.exitCode).toBe(0);
    expect(resendListHelp.stdout).toContain("resend.threads.list");
    expect(resendReplyHelp.exitCode).toBe(0);
    expect(resendReplyHelp.stdout).toContain("resend.threads.reply");
    expect(missingEvent.exitCode).toBe(127);
    expect(missingEvent.stderr).toContain("bash: event.emit: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.get",
        output: expect.stringContaining("pi.session.get"),
        exitCode: 0,
      },
      {
        command: "automations.identity.lookup-binding",
        output: expect.stringContaining("automations.identity.lookup-binding"),
        exitCode: 0,
      },
      {
        command: "otp.identity.create-claim",
        output: expect.stringContaining("otp.identity.create-claim"),
        exitCode: 0,
      },
      {
        command: "resend.threads.get",
        output: expect.stringContaining("resend.threads.get"),
        exitCode: 0,
      },
      {
        command: "resend.threads.list",
        output: expect.stringContaining("resend.threads.list"),
        exitCode: 0,
      },
      {
        command: "resend.threads.reply",
        output: expect.stringContaining("resend.threads.reply"),
        exitCode: 0,
      },
    ]);
  });

  it("loads automation event families only when automation context is provided", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: createAutomationContext(),
      },
    });

    const eventHelp = await bash.exec("event.reply --help");
    const missingPi = await bash.exec("pi.session.create --agent assistant");

    expect(eventHelp.exitCode).toBe(0);
    expect(eventHelp.stdout).toContain("event.reply");
    expect(missingPi.exitCode).toBe(127);
    expect(missingPi.stderr).toContain("bash: pi.session.create: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "event.reply",
        output: expect.stringContaining("event.reply"),
        exitCode: 0,
      },
    ]);
  });
});
