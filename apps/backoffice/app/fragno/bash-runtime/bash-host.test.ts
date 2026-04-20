import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";

import { createBashHost, createInteractiveBashHost } from "./bash-host";
import type { OtpBashRuntime } from "./otp-bash-runtime";
import type { PiBashRuntime } from "./pi-bash-runtime";
import type { ResendBashRuntime } from "./resend-bash-runtime";
import type { Reson8BashRuntime } from "./reson8-bash-runtime";

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

const createOtpRuntime = (): OtpBashRuntime => ({
  createClaim: async ({ source, externalActorId }) => ({
    url: `https://example.com/${source}/${externalActorId}`,
    externalId: externalActorId,
    code: "123456",
  }),
});

const createResendRuntime = (): ResendBashRuntime => ({
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

const createReson8Runtime = (): Reson8BashRuntime => ({
  transcribePrerecorded: async () => ({
    text: "hello world",
  }),
});

const createPiRuntime = (): PiBashRuntime => ({
  createSession: async () => ({
    id: "session-1",
    agent: "assistant",
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
    agent: "assistant",
    status: "waiting" as const,
    name: null,
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workflow: { status: "waiting" as const },
    messages: [],
    events: [],
    trace: [],
    summaries: [],
    turn: 0,
    phase: "waiting-for-user" as const,
    waitingFor: null,
  }),
  listSessions: async () => [
    {
      id: "session-1",
      name: null,
      status: "waiting" as const,
      agent: "assistant",
      steeringMode: "one-at-a-time" as const,
      metadata: null,
      tags: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ],
  runTurn: async ({ sessionId, text }) => ({
    id: sessionId,
    agent: "assistant",
    status: "waiting" as const,
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

const createInteractiveContext = () => ({
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
  telegram: {
    runtime: createTelegramRuntime(),
  },
});

const TEST_TEXT_ENCODER = new TextEncoder();
const TEST_TEXT_DECODER = new TextDecoder();

const createWritableWorkspaceMount = () => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/workspace", "/workspace/automations", "/workspace/events"]);
  const now = new Date("2026-01-01T00:00:00.000Z");

  const ensureDirectory = (path: string) => {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      directories.add(current);
    }
  };

  const ensureParentDirectory = (path: string) => {
    const segments = path.split("/").filter(Boolean);
    if (segments.length <= 1) {
      directories.add("/");
      return;
    }

    ensureDirectory(`/${segments.slice(0, -1).join("/")}`);
  };

  const listEntries = (path: string) => {
    const names = new Set<string>();
    const prefix = path === "/" ? "/" : `${path}/`;

    for (const directory of directories) {
      if (!directory.startsWith(prefix) || directory === path) {
        continue;
      }

      const remainder = directory.slice(prefix.length).split("/")[0]?.trim();
      if (remainder) {
        names.add(remainder);
      }
    }

    for (const filePath of files.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }

      const remainder = filePath.slice(prefix.length).split("/")[0]?.trim();
      if (remainder) {
        names.add(remainder);
      }
    }

    return Array.from(names).sort();
  };

  return normalizeMountedFileSystem(
    {
      readFile: async (path: string) =>
        TEST_TEXT_DECODER.decode(files.get(path) ?? new Uint8Array()),
      readFileBuffer: async (path: string) => files.get(path) ?? new Uint8Array(),
      writeFile: async (path: string, content: string | Uint8Array) => {
        ensureParentDirectory(path);
        files.set(path, typeof content === "string" ? TEST_TEXT_ENCODER.encode(content) : content);
      },
      mkdir: async (path: string) => {
        ensureDirectory(path);
      },
      stat: async (path: string) => ({
        isFile: files.has(path),
        isDirectory: directories.has(path),
        isSymbolicLink: false,
        mode: files.has(path) ? 0o644 : 0o755,
        size: files.get(path)?.byteLength ?? 0,
        mtime: now,
      }),
      readdir: async (path: string) => listEntries(path),
      getAllPaths: () => [...directories, ...files.keys()],
    },
    { readOnly: false },
  );
};

const createInteractiveMasterFs = async () => {
  const masterFs = new MasterFileSystem({ mounts: [] });
  masterFs.mount({
    id: "workspace",
    kind: "custom",
    mountPoint: "/workspace",
    title: "Workspace",
    readOnly: false,
    persistence: "session",
    fs: createWritableWorkspaceMount(),
  });

  return masterFs;
};

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
  bashEnv: {},
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

    expect(eventHelp.exitCode).toBe(0);
    expect(eventHelp.stdout).toContain("event.emit");
    expect(missingPi.exitCode).toBe(127);
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

    expect(telegramHelp.exitCode).toBe(0);
    expect(telegramHelp.stdout).toContain("telegram.file.get");
    expect(missingPi.exitCode).toBe(127);
    expect(missingPi.stderr).toContain("bash: pi.session.create: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.file.get",
        output: expect.stringContaining("telegram.file.get"),
        exitCode: 0,
      },
    ]);
  });

  it("exposes scripts.run in interactive bash hosts", async () => {
    const fs = await createInteractiveMasterFs();
    const { bash, commandCallsResult } = createInteractiveBashHost({
      fs,
      env: {} as CloudflareEnv,
      orgId: "org-1",
      context: createInteractiveContext(),
    });

    const result = await bash.exec("scripts.run --help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scripts.run");
    expect(commandCallsResult).toEqual([
      {
        command: "scripts.run",
        output: expect.stringContaining("scripts.run"),
        exitCode: 0,
      },
    ]);
  });

  it("inherits the parent orgId when the scripts.run fixture omits orgId", async () => {
    const fs = await createInteractiveMasterFs();
    await fs.writeFile("/workspace/automations/scripts/show-event.sh", "cat /context/event.json\n");
    await fs.writeFile(
      "/workspace/events/fixture-no-org.json",
      JSON.stringify({
        id: "evt-no-org",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { text: "hello" },
      }),
    );

    const { bash } = createInteractiveBashHost({
      fs,
      env: {} as CloudflareEnv,
      orgId: "org-1",
      context: createInteractiveContext(),
    });

    const result = await bash.exec(
      "scripts.run --script scripts/show-event.sh --event /workspace/events/fixture-no-org.json --format json",
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(JSON.parse(payload.stdout)).toMatchObject({
      id: "evt-no-org",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
    });
  });

  it("allows matching fixture orgId and preserves parent interactive capabilities during scripts.run", async () => {
    const fs = await createInteractiveMasterFs();
    await fs.writeFile(
      "/workspace/automations/scripts/check-capabilities.sh",
      [
        'printf "%s|%s\\n" "$(pi.session.get --session-id session-1 --print id)" "$(telegram.file.get --file-id file-1 --print filePath)"',
        "resend.threads.list --help >/dev/null",
        "reson8.prerecorded.transcribe --help >/dev/null",
      ].join("\n"),
    );
    await fs.writeFile(
      "/workspace/events/fixture-matching-org.json",
      JSON.stringify({
        id: "evt-matching-org",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { text: "hello" },
      }),
    );

    const { bash } = createInteractiveBashHost({
      fs,
      env: {} as CloudflareEnv,
      orgId: "org-1",
      context: createInteractiveContext(),
    });

    const result = await bash.exec(
      "scripts.run --script scripts/check-capabilities.sh --event /workspace/events/fixture-matching-org.json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("session-1|voice/file-1.ogg");
  });

  it("fails clearly when a scripts.run fixture claims a different orgId", async () => {
    const fs = await createInteractiveMasterFs();
    await fs.writeFile("/workspace/automations/scripts/noop.sh", "echo should-not-run\n");
    await fs.writeFile(
      "/workspace/events/fixture-mismatched-org.json",
      JSON.stringify({
        id: "evt-mismatched-org",
        orgId: "org-2",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      }),
    );

    const { bash, commandCallsResult } = createInteractiveBashHost({
      fs,
      env: {} as CloudflareEnv,
      orgId: "org-1",
      context: createInteractiveContext(),
    });

    const result = await bash.exec(
      "scripts.run --script scripts/noop.sh --event /workspace/events/fixture-mismatched-org.json",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fixture-mismatched-org.json");
    expect(result.stderr).toContain("orgId 'org-2'");
    expect(result.stderr).toContain("interactive org 'org-1'");
    expect(commandCallsResult).toEqual([
      {
        command: "scripts.run",
        output: "",
        exitCode: 1,
      },
    ]);
  });
});
