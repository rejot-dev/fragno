import { describe, expect, it, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { createTestStateBackend } from "@/fragno/codemode/state-backend.test-utils";
import type { PiManagerRuntime } from "@/fragno/pi-manager/pi-manager-runtime";

import { createInteractiveBashHost } from "./automation-host";
import type { StoreSetArgs } from "./automation-types";
import { createBashHost } from "./bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "./bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "./families/automations-routing";
import { createUnavailableEventRuntime } from "./families/event-runtime";
import type { OtpRuntime } from "./families/otp-runtime";
import type { ResendRuntime } from "./families/resend-runtime";

const automationStoreActor = {
  scope: "external",
  source: "telegram",
  type: "chat",
  id: "actor-1",
} as const;

const createAutomationsRuntime = () => ({
  ...createUnavailableAutomationRouterRuntime(),
  get: async () => ({
    source: "telegram",
    key: "actor-1",
    value: "user-1",
    status: "linked",
    category: [],
  }),
  set: async (input: StoreSetArgs & { source?: string }) => ({
    id: input.key,
    source: input.source,
    key: input.key,
    value: input.value,
    status: "linked",
    category: [],
  }),
  delete: async ({ key }: Record<string, string>) => ({ ok: true as const, key }),
  list: async () => [],
});

const createOtpRuntime = (): OtpRuntime => ({
  createClaim: async () => ({
    url: `https://example.com/${automationStoreActor.source}/${automationStoreActor.id}`,
    externalId: automationStoreActor.id,
    otpId: "otp_123456",
    code: "123456",
    actor: automationStoreActor,
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

const createPiRuntime = (): PiManagerRuntime => {
  const session = {
    name: null,
    model: { provider: "openai", modelId: "test-model" },
    instructions: "",
    billingOrganizationId: "org-1",
    scopeRestriction: null,
    scope: { kind: "org" as const, orgId: "org-1" },
    sessionId: "session-1",
    actors: {
      initiator: {
        scope: "internal" as const,
        type: "service",
        id: "automation-host-test",
        role: "initiator" as const,
      },
      principal: null,
      delegation: [],
    },
  };
  const directorySession = { ...session, createdAt: "2026-01-01T00:00:00.000Z" };
  return {
    createSession: async () => session,
    getSession: async () => ({
      ...directorySession,
      view: { conversation: { id: 1 } as never, entries: [], docs: {} },
    }),
    listSessions: async () => ({
      sessions: [directorySession],
      cursor: null,
      hasNextPage: false,
    }),
    submitPrompt: async () => ({ submissionId: 1, requestId: "request-1" }),
    getSubmission: async () =>
      ({
        id: 1,
        conversationId: 1,
        requestId: "request-1",
        type: "input",
        status: "done",
        entry: "input-1",
        answer: "answer-1",
      }) as never,
    runPrompt: async ({ content }) => ({
      ...directorySession,
      view: { conversation: { id: 1 } as never, entries: [], docs: {} },
      submission: {
        id: 1,
        conversationId: 1,
        requestId: "request-1",
        type: "input",
        status: "done",
        entry: "input-1",
        answer: "answer-1",
      } as never,
      assistantText: content,
    }),
    abortSession: async () => undefined,
  };
};

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
    scopeRestriction: null,
    scope: { kind: "org" as const, orgId: "org-1" },
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {},
    actors: {
      initiator: {
        scope: "external" as const,
        source: "telegram",
        type: "chat",
        id: "chat-1",
        role: "initiator" as const,
      },
      principal: null,
      delegation: [],
    },
  },
  orgId: "org-1",
  binding: {
    source: "telegram",
    eventType: "message.received",
    scriptId: "script-1",
  },
  idempotencyKey: "idem-1",
  runtime: {
    ...createUnavailableEventRuntime(),
    emitEvent: async ({ eventType, source }: { eventType: string; source?: string }) => ({
      accepted: true,
      eventId: "emitted-1",
      scope: { kind: "org" as const, orgId: "org-1" },
      source: source ?? "telegram",
      eventType,
    }),
  },
});

describe("interactive bash host", () => {
  it("explains when a known command requires a different scope", async () => {
    const { bash, commandCallsResult } = createInteractiveBashHost({
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        stateBackend: createTestStateBackend(),
        execution: {
          ...EMPTY_BASH_HOST_CONTEXT.execution,
          scope: { kind: "org", orgId: "org-1" },
        },
      },
    });

    const result = await bash.exec(
      "admin.org.create --name Acme --slug acme --owner-email owner@example.com",
    );

    assert(result.exitCode === 1);
    expect(result.stderr).toContain(
      "Backoffice command unavailable: 'admin.org.create' is not supported in the current organization scope.",
    );
    expect(result.stderr).toContain(
      "Admin commands require the System scope. Select System in the Backoffice scope switcher and retry.",
    );
    expect(result.stderr).toContain("context.current --format json");
    expect(commandCallsResult).toEqual([{ command: "admin.org.create", output: "", exitCode: 1 }]);
  });
});

describe("bash host command assembly", () => {
  it("loads pi, automations, otp, and resend command families without exposing automation event commands", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
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
    const missingEvent = await bash.exec("events.fire --event-type test");

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
    expect(missingEvent.stderr).toContain("bash: events.fire: command not found");
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
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: createAutomationContext(),
        automations: null,
        otp: null,
        pi: null,
        resend: null,
        telegram: null,
      },
    });

    const eventHelp = await bash.exec("events.fire --help");
    const missingPi = await bash.exec("pi.session.create");

    assert(eventHelp.exitCode === 0);
    expect(eventHelp.stdout).toContain("events.fire");
    assert(missingPi.exitCode === 127);
    expect(missingPi.stderr).toContain("bash: pi.session.create: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "events.fire",
        output: expect.stringContaining("events.fire"),
        exitCode: 0,
      },
    ]);
  });

  it("loads telegram file commands only when telegram context is provided", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const telegramHelp = await bash.exec("telegram.file.get --help");
    const missingPi = await bash.exec("pi.session.create");

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
