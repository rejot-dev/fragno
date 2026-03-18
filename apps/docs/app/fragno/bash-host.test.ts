import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "./bash-host";

const createAutomationsRuntime = () => ({
  lookupBinding: async () => ({
    source: "telegram",
    externalActorId: "actor-1",
    userId: "user-1",
    status: "linked",
  }),
  bindActor: async ({ source, externalActorId, userId }: Record<string, string>) => ({
    source,
    externalActorId,
    userId,
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
  cloudflareEnv: {},
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
  it("loads pi, automations, and otp command families without exposing automation event commands", async () => {
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
      },
    });

    const piHelp = await bash.exec("pi.session.get --help");
    const automationsHelp = await bash.exec("automations.identity.lookup-binding --help");
    const otpHelp = await bash.exec("otp.identity.create-claim --help");
    const missingEvent = await bash.exec("event.emit --event-type test");

    expect(piHelp.exitCode).toBe(0);
    expect(piHelp.stdout).toContain("pi.session.get");
    expect(automationsHelp.exitCode).toBe(0);
    expect(automationsHelp.stdout).toContain("automations.identity.lookup-binding");
    expect(otpHelp.exitCode).toBe(0);
    expect(otpHelp.stdout).toContain("otp.identity.create-claim");
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
