import { describe, expect, it, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";

import { createInteractiveBashHost } from "./automation-host";
import type { StoreSetArgs } from "./automation-types";
import { createBashHost } from "./bash-host";
import type { OtpRuntime } from "./families/otp-runtime";
import type { PiRuntime } from "./families/pi-runtime";
import type { ResendRuntime } from "./families/resend-runtime";
import type { Reson8Runtime } from "./families/reson8-runtime";

const automationStoreActor = {
  scope: "external",
  source: "telegram",
  type: "chat",
  id: "actor-1",
} as const;

const createAutomationsRuntime = () => ({
  get: async () => ({
    source: "telegram",
    key: "actor-1",
    value: "user-1",
    status: "linked",
    category: [],
    actor: automationStoreActor,
  }),
  set: async (input: StoreSetArgs & { source?: string }) => ({
    source: input.source,
    key: input.key,
    value: input.value,
    status: "linked",
    category: [],
    actor: input.actor ?? automationStoreActor,
  }),
  delete: async ({ key }: Record<string, string>) => ({ ok: true as const, key }),
  list: async () => [],
});

const createOtpRuntime = (): OtpRuntime => ({
  createClaim: async ({ actor }) => ({
    url: `https://example.com/${actor.source}/${actor.id}`,
    externalId: actor.id,
    otpId: "otp_123456",
    code: "123456",
    actor,
  }),
});

const createResendRuntime = (): ResendRuntime => ({
  listThreads: async () => ({
    threads: [],
    hasNextPage: false,
  }),
  getThread: async ({ threadId }) => ({
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
  getThreadSnapshot: async ({ threadId }) => ({
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
  replyToThread: async ({ threadId, subject, body }) => ({
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

const createReson8Runtime = (): Reson8Runtime => ({
  transcribePrerecorded: async () => ({
    text: "hello world",
  }),
});

const createPiRuntime = (): PiRuntime => ({
  createSession: async () => ({
    id: "session-1",
    agent: "assistant",
    workflowName: "interactive-chat-workflow",
    status: "waiting" as const,
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  getSession: async ({ sessionId }) => ({
    id: sessionId,
    agentName: "assistant",
    workflowName: "interactive-chat-workflow",
    agent: { state: { messages: [] }, events: [] },
    status: "waiting" as const,
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workflow: { status: "waiting" as const },
  }),
  listSessions: async () => [
    {
      id: "session-1",
      name: null,
      status: "waiting" as const,
      agent: "assistant",
      workflowName: "interactive-chat-workflow",
      steeringMode: "one-at-a-time" as const,
      metadata: null,
      tags: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ],
  runTurn: async ({ sessionId, text }) => ({
    id: sessionId,
    agentName: "assistant",
    workflowName: "interactive-chat-workflow",
    agent: {
      state: {
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
      },
      events: [],
    },
    status: "waiting" as const,
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workflow: { status: "waiting" as const },
    assistantText: text,
    messageStatus: "active" as const,
    stream: [
      {
        type: "snapshot" as const,
        state: {
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
        },
      },
    ],
    terminalState: {
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
    },
  }),
});

const createTelegramRuntime = () => ({
  getFile: async ({ fileId }: { fileId: string }) => ({
    fileId,
    fileUniqueId: `unique-${fileId}`,
    filePath: `voice/${fileId}.ogg`,
    fileSize: 4,
  }),
  downloadFile: async () => new Response(new Uint8Array([0, 255, 1, 2])),
  sendMessage: async () => ({ ok: true, queued: true }),
  sendChatAction: async () => ({ ok: true }),
  editMessage: async () => ({ ok: true, queued: true }),
});

const createAutomationContext = () => ({
  event: {
    id: "event-1",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
    actor: { scope: "external" as const, source: "telegram", type: "chat", id: "chat-1" },
    actors: [{ scope: "external" as const, source: "telegram", type: "chat", id: "chat-1" }],
  },
  orgId: "org-1",
  binding: {
    source: "telegram",
    eventType: "message.received",
    scriptId: "script-1",
  },
  idempotencyKey: "idem-1",
  runtime: {
    emitEvent: async ({ eventType, source }: { eventType: string; source?: string }) => ({
      accepted: true,
      eventId: "emitted-1",
      orgId: "org-1",
      source: source ?? "telegram",
      eventType,
    }),
  },
});

describe("interactive bash host", () => {
  it("mounts /dev/null for dashboard-style commands backed by a master filesystem", async () => {
    const { bash } = createInteractiveBashHost({
      fs: new MasterFileSystem({ mounts: [] }),
      env: {} as CloudflareEnv,
      orgId: "org-1",
      includeDevMount: true,
      context: {
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const result = await bash.exec("echo discarded >/dev/null && echo kept");

    assert(result.exitCode === 0);
    assert(result.stdout === "kept\n");
    assert(result.stderr === "");
  });
});

describe("bash host command assembly", () => {
  it("loads pi, automations, otp, and resend command families without exposing automation event commands", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: {
          runtime: createAutomationsRuntime(),
        },
        otp: {
          runtime: createOtpRuntime(),
        },
        pi: {
          runtime: createPiRuntime(),
        },
        reson8: {
          runtime: createReson8Runtime(),
        },
        resend: {
          runtime: createResendRuntime(),
        },
        telegram: null,
      },
    });

    const piHelp = await bash.exec("pi.session.get --help");
    const automationsHelp = await bash.exec("store.get --help");
    const otpHelp = await bash.exec("otp.identity.create-claim --help");
    const resendGetHelp = await bash.exec("resend.threads.get --help");
    const resendListHelp = await bash.exec("resend.threads.list --help");
    const resendReplyHelp = await bash.exec("resend.threads.reply --help");
    const missingEvent = await bash.exec("event.emit --event-type test");

    assert(piHelp.exitCode === 0);
    expect(piHelp.stdout).toContain("pi.session.get");
    assert(automationsHelp.exitCode === 0);
    expect(automationsHelp.stdout).toContain("store.get");
    assert(otpHelp.exitCode === 0);
    expect(otpHelp.stdout).toContain("otp.identity.create-claim");
    assert(resendGetHelp.exitCode === 0);
    expect(resendGetHelp.stdout).toContain("resend.threads.get");
    assert(resendListHelp.exitCode === 0);
    expect(resendListHelp.stdout).toContain("resend.threads.list");
    assert(resendReplyHelp.exitCode === 0);
    expect(resendReplyHelp.stdout).toContain("resend.threads.reply");
    assert(missingEvent.exitCode === 127);
    expect(missingEvent.stderr).toContain("bash: event.emit: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.get",
        output: expect.stringContaining("pi.session.get"),
        exitCode: 0,
      },
      {
        command: "store.get",
        output: expect.stringContaining("store.get"),
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
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      },
    });

    const eventHelp = await bash.exec("event.emit --help");
    const missingPi = await bash.exec("pi.session.create --agent assistant");

    assert(eventHelp.exitCode === 0);
    expect(eventHelp.stdout).toContain("event.emit");
    assert(missingPi.exitCode === 127);
    expect(missingPi.stderr).toContain("bash: pi.session.create: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "event.emit",
        output: expect.stringContaining("event.emit"),
        exitCode: 0,
      },
    ]);
  });

  it("loads telegram file commands only when telegram context is provided", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const telegramHelp = await bash.exec("telegram.file.get --help");
    const missingPi = await bash.exec("pi.session.create --agent assistant");

    assert(telegramHelp.exitCode === 0);
    expect(telegramHelp.stdout).toContain("telegram.file.get");
    assert(missingPi.exitCode === 127);
    expect(missingPi.stderr).toContain("bash: pi.session.create: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.file.get",
        output: expect.stringContaining("telegram.file.get"),
        exitCode: 0,
      },
    ]);
  });
});
