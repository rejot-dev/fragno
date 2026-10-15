import { describe, expect, it, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { createTestStateBackend } from "@/fragno/codemode/state-backend.test-utils";
import type { PiManagerRuntime } from "@/fragno/pi/manager/pi-manager-runtime";

import { createInteractiveBashHost } from "./automation-host";
import type { StoreSetArgs } from "./automation-types";
import { createBashHost } from "./bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "./bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "./families/automations-routing";
import { createUnavailableEventRuntime } from "./families/event-runtime";
import type { OtpRuntime } from "./families/otp-runtime";

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

const createPiRuntime = (): PiManagerRuntime => {
  const submission = {
    id: 1,
    conversationId: 1,
    requestId: "request-1",
    type: "input",
    status: "done",
    entry: "input-1",
    answer: "answer-1",
  } as never;
  return {
    listAgents: async () => ({ agents: [] }),
    getAgent: async ({ agentName }) => ({
      agentName,
      description: "General-purpose assistant.",
      model: null,
      permissions: ["*"],
      instructionsPath: null,
      managedBy: { kind: "built-in" },
      provisioning: null,
      view: null,
    }),
    createAgent: async ({ managedBy, ...definition }) => ({ ...definition, managedBy }),
    updateAgent: async ({ managedBy, ...definition }) => ({ ...definition, managedBy }),
    deleteAgent: async () => undefined,
    submitPrompt: async () => ({ submissionId: 1, requestId: "request-1", whenBusy: "followUp" }),
    getSubmission: async () => submission,
    runPrompt: async ({ agentName, content }) => ({
      agentName,
      view: { conversation: { id: 1 } as never, entries: [], docs: {} },
      submission,
      assistantText: content,
    }),
    abortAgent: async () => undefined,
  };
};

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
  it("loads pi, automations, and otp command families without exposing automation event commands", async () => {
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
      },
    });

    const piHelp = await bash.exec("pi.agent.get --help");
    const automationsHelp = await bash.exec("store.get --help");
    const otpHelp = await bash.exec("otp.identity.create-claim --help");
    const missingEvent = await bash.exec("events.fire --event-type test");

    assert(piHelp.exitCode === 0);
    expect(piHelp.stdout).toContain("pi.agent.get");
    assert(automationsHelp.exitCode === 0);
    expect(automationsHelp.stdout).toContain("store.get");
    assert(otpHelp.exitCode === 0);
    expect(otpHelp.stdout).toContain("otp.identity.create-claim");
    assert(missingEvent.exitCode === 127);
    expect(missingEvent.stderr).toContain("bash: events.fire: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "pi.agent.get",
        output: expect.stringContaining("pi.agent.get"),
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
      },
    });

    const eventHelp = await bash.exec("events.fire --help");
    const missingPi = await bash.exec("pi.agent.list");

    assert(eventHelp.exitCode === 0);
    expect(eventHelp.stdout).toContain("events.fire");
    assert(missingPi.exitCode === 127);
    expect(missingPi.stderr).toContain("bash: pi.agent.list: command not found");
    expect(commandCallsResult).toEqual([
      {
        command: "events.fire",
        output: expect.stringContaining("events.fire"),
        exitCode: 0,
      },
    ]);
  });
});
