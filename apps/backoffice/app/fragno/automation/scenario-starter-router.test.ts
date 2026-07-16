import { assert, describe, test, vi } from "vitest";

import type { AutomationEvent } from "./contracts";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";
import { automationFragmentSchema } from "./schema";

const customAutomationEvent = ({
  id,
  source = "custom",
  eventType = "thing.happened",
  payload = {},
}: {
  id: string;
  source?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
}): AutomationEvent => ({
  id,
  scope: { kind: "org", orgId: "org-1" },
  source,
  eventType,
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload,
  actor: { scope: "internal", type: "system", id: "scenario", role: "system" },
  actors: [{ scope: "internal", type: "system", id: "scenario", role: "system" }],
  subject: { orgId: "org-1" },
});

const telegramMessageEvent = ({
  id,
  text,
  chatId = "1001",
}: {
  id: string;
  text: string;
  chatId?: string;
}): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: "telegram",
    type: "chat",
    id: chatId,
  };

  return {
    id,
    scope: { kind: "org", orgId: "org-1" },
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      chatId,
      text,
    },
    actor,
    actors: [actor],
    subject: { orgId: "org-1" },
  };
};

describe("starter automation router scenarios", () => {
  test("scenario Lofi helper drains and queries frontend-visible data", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario lofi helper drains and queries frontend-visible data",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, when }) => [
          when.automation.ingestEvent(
            customAutomationEvent({ id: "lofi-event-1", payload: { ok: true } }),
          ),
          then.assert("assert event is visible through Lofi", async (ctx) => {
            const lofi = ctx.lofi.forOrg("org-1");
            await lofi.drain();
            const query = lofi.query(automationFragmentSchema);
            const event = await query.findFirst("automation_event", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "lofi-event-1")),
            );
            assert.equal(event?.source, "custom");
            assert.equal(event?.eventType, "thing.happened");
          }),
        ],
      }),
    );
  });

  test("scenario router helpers seed and inspect starter routes", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router helpers inspect starter routes",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),

          then.router.routes({
            orgId: "org-1",
            include: [
              {
                id: "telegram-test-command",
                trigger: {
                  kind: "event",
                  source: "telegram",
                  eventType: "message.received",
                  matcher: { path: "$.payload.text", op: "eq", value: "/test" },
                },
                action: {
                  kind: "start_workflow",
                  remoteWorkflowName: "telegram-test-command",
                  workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
                },
              },
              {
                id: "telegram-identity-claim-completed",
                action: {
                  kind: "send_workflow_event",
                  target: {
                    kind: "stored_instance_id",
                    keyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
                  },
                  eventType: "identity-claim-completed",
                },
              },
              "pi-default-agent-configure",
            ],
          }),
          then.router.route({
            orgId: "org-1",
            id: "telegram-pi-linking",
            enabled: true,
            priority: 120,
            trigger: { kind: "event" },
          }),
          then.assert("assert starter routes are visible through Lofi", async (ctx) => {
            const lofi = ctx.lofi.forOrg("org-1");
            await lofi.drain();
            const routes = await lofi
              .query(automationFragmentSchema)
              .find("automation_route", (b) => b.whereIndex("primary"));
            const expectedIds = [
              "telegram-test-command",
              "telegram-identity-claim-completed",
              "pi-default-agent-configure",
            ];
            const missing = expectedIds.filter(
              (expectedId) => !routes.some((route) => route.id.externalId === expectedId),
            );
            assert.equal(missing.length, 0);
          }),
          then.router.missing({ orgId: "org-1", id: "no-such-route" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("disabling a starter route stops it from starting workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router disables starter route",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),
          when.router.updateRoute({ orgId: "org-1", id: "telegram-test-command", enabled: false }),
          then.router.route({ orgId: "org-1", id: "telegram-test-command", enabled: false }),

          when.automation.ingestEvent(telegramMessageEvent({ id: "disabled-test", text: "/test" })),

          then.workflow.missing({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-disabled-test",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("updating a starter route matcher changes which events start it", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router updates starter matcher",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),
          when.router.updateRoute({
            orgId: "org-1",
            id: "telegram-test-command",
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.text", op: "eq", value: "!test" },
            },
            priority: 110,
          }),
          then.router.route({
            orgId: "org-1",
            id: "telegram-test-command",
            trigger: {
              kind: "event",
              matcher: { path: "$.payload.text", op: "eq", value: "!test" },
            },
          }),

          when.automation.ingestEvent(telegramMessageEvent({ id: "old-test", text: "/test" })),
          when.automation.ingestEvent(telegramMessageEvent({ id: "bang-test", text: "!test" })),

          then.workflow.missing({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-old-test",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-bang-test",
            status: "complete",
            output: { skipped: true, reason: "not-test-command" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("creating a route starts a custom workflow for matching events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router creates custom start route",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/custom-alpha.workflow.js",
            content: `defineWorkflow(
  { name: "custom-alpha" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;
    await step.do("store custom route hit", async () => {
      await store.set({
        key: "custom/" + automationEvent.id,
        value: automationEvent.payload.kind,
        actor: automationEvent.actor,
        category: ["test", "router"],
      });
    });
    return { eventId: automationEvent.id, kind: automationEvent.payload.kind };
  },
);
`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "custom-alpha",
            name: "Custom alpha",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: { path: "$.payload.kind", op: "eq", value: "alpha" },
            },
            priority: 50,
            action: {
              kind: "start_workflow",
              workflowName: "automation-codemode-script",
              remoteWorkflowName: "custom-alpha",
              workflowScriptPath: "/workspace/automations/custom-alpha.workflow.js",
              instanceIdTemplate: "custom-alpha-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          then.router.route({
            orgId: "org-1",
            id: "custom-alpha",
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
            },
          }),

          when.automation.ingestEvent(
            customAutomationEvent({ id: "alpha-1", payload: { kind: "alpha" } }),
          ),
          when.automation.ingestEvent(
            customAutomationEvent({ id: "beta-1", payload: { kind: "beta" } }),
          ),

          then.assert("assert automation events are visible through Lofi", async (ctx) => {
            const lofi = ctx.lofi.forOrg("org-1");
            await lofi.drain();
            const query = lofi.query(automationFragmentSchema);
            const alphaEvent = await query.findFirst("automation_event", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "alpha-1")),
            );
            const betaEvent = await query.findFirst("automation_event", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "beta-1")),
            );
            assert.deepEqual(alphaEvent?.payload, { kind: "alpha" });
            assert.deepEqual(betaEvent?.payload, { kind: "beta" });
          }),

          then.workflow.instance({
            remoteWorkflowName: "custom-alpha",
            instanceId: "custom-alpha-alpha-1",
            status: "complete",
            output: { eventId: "alpha-1", kind: "alpha" },
          }),
          then.workflow.missing({
            remoteWorkflowName: "custom-alpha",
            instanceId: "custom-alpha-beta-1",
          }),
          then.store.entry({ orgId: "org-1", key: "custom/alpha-1", value: "alpha" }),
          then.assert(
            "assert custom workflow store output is visible through Lofi",
            async (ctx) => {
              const lofi = ctx.lofi.forOrg("org-1");
              await lofi.drain();
              const [entry] = await lofi
                .query(automationFragmentSchema)
                .find("kv_store", (b) =>
                  b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", "custom/alpha-1")),
                );
              assert.equal(entry?.value, "alpha");
            },
          ),
          then.store.missing({ orgId: "org-1", key: "custom/beta-1" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("start_workflow route skips cleanly when the workflow file is missing", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router missing workflow file skips",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.router.route({
            orgId: "org-1",
            id: "missing-workflow-file",
            name: "Missing workflow file",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: { path: "$.payload.kind", op: "eq", value: "missing-file" },
            },
            priority: 50,
            action: {
              kind: "start_workflow",
              workflowName: "automation-codemode-script",
              remoteWorkflowName: "missing-workflow-file",
              workflowScriptPath: "/workspace/automations/missing-workflow-file.workflow.js",
              instanceIdTemplate: "missing-workflow-file-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            customAutomationEvent({ id: "missing-file-1", payload: { kind: "missing-file" } }),
          ),

          then.workflow.instance({
            remoteWorkflowName: "missing-workflow-file",
            instanceId: "missing-workflow-file-missing-file-1",
            status: "complete",
            output: {
              skipped: true,
              reason: "workflow-script-not-found",
              workflowScriptPath: "/workspace/automations/missing-workflow-file.workflow.js",
            },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("send_workflow_event routes wake a workflow from a stored instance id", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router sends workflow event",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/custom-waiter.workflow.js",
            content: `defineWorkflow(
  { name: "custom-waiter" },
  async (_event, step) => {
    const signal = await step.waitForEvent("custom-signal", {
      type: "custom-signal",
      timeout: "15 minutes",
    });
    const signalEvent = signal.payload;
    await step.do("store custom signal", async () => {
      await store.set({
        key: "signal/" + signalEvent.payload.key,
        value: signalEvent.payload.value,
        actor: signalEvent.actor,
        category: ["test", "router"],
      });
    });
    return { received: signalEvent.payload.value };
  },
);
`,
          }),
          given.store.entry({ orgId: "org-1", key: "waiter/alpha", value: "waiter-1" }),
          given.router.route({
            orgId: "org-1",
            id: "custom-signal-forwarder",
            name: "Custom signal forwarder",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "signal.received",
              matcher: { path: "$.payload.key", op: "eq", value: "alpha" },
            },
            priority: 40,
            action: {
              kind: "send_workflow_event",
              workflowName: "automation-codemode-script",
              target: { kind: "stored_instance_id", keyTemplate: "waiter/${event.payload.key}" },
              eventType: "custom-signal",
              payload: "$event",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "custom-waiter",
            instanceId: "waiter-1",
            params: {
              automationEvent: customAutomationEvent({ id: "waiter-bootstrap" }),
              workflowScriptPath: "/workspace/automations/custom-waiter.workflow.js",
            },
          }),
          then.workflow.instance({
            remoteWorkflowName: "custom-waiter",
            instanceId: "waiter-1",
            status: "waiting",
            waitingFor: "custom-signal",
          }),

          when.automation.ingestEvent(
            customAutomationEvent({
              id: "signal-1",
              eventType: "signal.received",
              payload: { key: "alpha", value: "delivered" },
            }),
          ),

          then.workflow.instance({
            remoteWorkflowName: "custom-waiter",
            instanceId: "waiter-1",
            status: "complete",
            output: { received: "delivered" },
          }),
          then.store.entry({ orgId: "org-1", key: "signal/alpha", value: "delivered" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("pi capability.configured stores the default Pi agent", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter router stores the default Pi agent",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.capability.configured.pi({
            orgId: "org-1",
            harnessId: "default",
            harnessLabel: "Default",
            harnessTools: ["bash"],
            modelProvider: "openai",
            modelName: "gpt-5-mini",
            modelLabel: "GPT-5 mini",
          }),

          then.workflow.instance({
            remoteWorkflowName: "pi-default-agent-configure",
            instanceId: "pi-default-agent-configure-pi-capability-configured-org-1",
            status: "complete",
            output: { stored: true, value: "default::openai::gpt-5-mini" },
          }),
          then.store.entry({
            orgId: "org-1",
            key: "pi/pi-default-agent",
            value: "default::openai::gpt-5-mini",
          }),
          then.assert("assert default Pi agent is visible through Lofi", async (ctx) => {
            const lofi = ctx.lofi.forOrg("org-1");
            await lofi.drain();
            const [entry] = await lofi
              .query(automationFragmentSchema)
              .find("kv_store", (b) =>
                b.whereIndex("idx_kv_store_key", (eb) => eb("key", "=", "pi/pi-default-agent")),
              );
            assert.equal(entry?.value, "default::openai::gpt-5-mini");
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi creates a Pi session for a linked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi creates a Pi session",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured.pi({
            orgId: "org-1",
            harnessId: "default",
            modelProvider: "openai",
            modelName: "gpt-5-mini",
          }),
          then.workflow.instance({
            remoteWorkflowName: "pi-default-agent-configure",
            instanceId: "pi-default-agent-configure-pi-capability-configured-org-1",
            status: "complete",
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_001,
            messageId: 601,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.pi.createdSession({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi skips a linked chat when no default Pi agent is stored", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi skips without a default Pi agent",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_004,
            messageId: 604,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { skipped: true, reason: "missing-default-agent" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi skips an unlinked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi skips an unlinked chat",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_006,
            messageId: 606,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { skipped: true, reason: "telegram-chat-not-linked" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram text skips an unlinked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram text skips an unlinked chat",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_007,
            messageId: 607,
            chatId: "1001",
            text: "Hello Pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { skipped: true, reason: "telegram-chat-not-linked" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram unrelated slash commands do not create starter workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram slash command is ignored",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_008,
            messageId: 608,
            chatId: "1001",
            text: "/help",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-test-command" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-pi-linking" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("raw Telegram webhooks without messages do not create starter workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter raw Telegram webhook without message is ignored",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.webhook({
            orgId: "org-1",
            label: "receive Telegram webhook without a message",
            update: {
              update_id: 21_001,
              my_chat_member: {
                chat: { id: 1001, type: "private" },
                from: { id: 2001, is_bot: false, first_name: "Ada" },
                date: 1_780_000_000,
                old_chat_member: { status: "member", user: { id: 123, is_bot: true } },
                new_chat_member: { status: "kicked", user: { id: 123, is_bot: true } },
              },
            },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-test-command" }),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-pi-linking" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-pi-linking skips slash commands other than /pi", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-pi-linking skips unrelated slash commands",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-unrelated-command",
            params: {
              automationEvent: telegramMessageEvent({
                id: "telegram:message:unrelated-pi-command",
                text: "/help",
              }),
              workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
            },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi session creation, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-unrelated-command",
            status: "complete",
            output: { skipped: true, reason: "not-telegram-pi-message" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram text reuses a Pi session and forwards assistant text", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram text reuses a Pi session",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_002,
            messageId: 602,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_003,
            messageId: 603,
            chatId: "1001",
            text: "Hello Pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.pi.createdSession({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.assert("assert Pi session was reused", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Pi session creation, got ${calls.length}.`);
            }
          }),
          then.store.entries({
            orgId: "org-1",
            prefix: "telegram",
            include: [
              { key: "telegram/1001", value: "user-1" },
              { key: "telegram-pi-session/user-1", value: "pi-session-1" },
            ],
          }),
          then.telegram.sentChatAction({
            chatId: "1001",
            action: "typing",
          }),
          then.pi.ranTurn({
            sessionId: "pi-session-1",
            text: "Hello Pi",
            assistantText: "agent:Hello Pi",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "agent:Hello Pi",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi reuses an active stored Pi session", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi reuses an active Pi session",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_009,
            messageId: 609,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_010,
            messageId: 610,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.assert("assert Pi session creation was reused", (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Pi session creation, got ${calls.length}.`);
            }
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Pi session: pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi replaces a missing stored Pi session", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /pi replaces a missing stored Pi session",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-missing",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_011,
            messageId: 611,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.assert("assert missing Pi session was checked", (ctx) => {
            const calls = ctx.fakes.pi?.getSessionCalls ?? [];
            if (!calls.some((call) => call.sessionId === "pi-session-missing")) {
              throw new Error(`Expected missing Pi session lookup, got ${JSON.stringify(calls)}.`);
            }
          }),
          then.pi.createdSession({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test.each(["terminated", "complete", "errored"] as const)(
    "Telegram /pi replaces a %s stored Pi session",
    async (status) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: `starter Telegram /pi replaces a ${status} Pi session`,

          files: backofficeFiles.workspaceStarter(),

          fakes: ({ fake }) => ({
            telegram: fake.telegram(),
            pi: fake.pi(),
          }),

          setup: ({ given }) => [
            given.organization.exists({ id: "org-1", name: "Ada Labs" }),
            given.telegram.configured({
              orgId: "org-1",
              botUsername: "fragno_bot",
            }),
            given.pi.defaultAgent({
              orgId: "org-1",
              value: "default::openai::gpt-5-mini",
            }),
            given.store.entry({
              orgId: "org-1",
              key: "telegram/1001",
              value: "user-1",
            }),
          ],

          steps: ({ when, then }) => [
            when.telegram.receivesMessage({
              orgId: "org-1",
              updateId: `terminal-${status}-1`,
              messageId: 612,
              chatId: "1001",
              text: "/pi",
              from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
            }),

            then.assert(`mark Pi session ${status}`, (ctx) => {
              ctx.fakes.pi?.setSessionStatus("pi-session-1", status);
            }),

            when.telegram.receivesMessage({
              orgId: "org-1",
              updateId: `terminal-${status}-2`,
              messageId: 613,
              chatId: "1001",
              text: "/pi",
              from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
            }),

            then.assert("assert replacement Pi session was created", (ctx) => {
              const calls = ctx.fakes.pi?.createSessionCalls ?? [];
              if (calls.length !== 2) {
                throw new Error(`Expected two Pi session creations, got ${calls.length}.`);
              }
            }),
            then.store.entry({
              orgId: "org-1",
              key: "telegram-pi-session/user-1",
              value: "pi-session-2",
            }),
            then.telegram.sentMessage({
              chatId: "1001",
              text: "Created Pi session: pi-session-2",
            }),
            then.workflow.instance({
              remoteWorkflowName: "telegram-user-pi-linking",
              status: "complete",
              output: { sessionId: "pi-session-2" },
            }),
            then.workflow.noErrored({ orgId: "org-1" }),
          ],
        }),
      );
    },
  );

  test("Telegram text with no Pi assistant text sends no response message", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram text sends no message when Pi has no assistant text",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi({ assistantText: () => "" }),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "default::openai::gpt-5-mini",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_014,
            messageId: 614,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_015,
            messageId: 615,
            chatId: "1001",
            text: "No response expected",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.sentChatAction({
            chatId: "1001",
            action: "typing",
          }),
          then.pi.ranTurn({
            sessionId: "pi-session-1",
            text: "No response expected",
            assistantText: "",
          }),
          then.assert("assert only the Pi creation message was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Telegram message, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /test sends the delayed reply after time advances", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram /test waits before sending a reply",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_005,
            messageId: 605,
            chatId: "1001",
            text: "/test",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            status: "waiting",
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-test-command",
            include: ["wait 3 seconds"],
          }),

          when.time.advance("3 seconds"),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "Delayed /test reply after 3 seconds.",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            status: "complete",
            output: { sent: true },
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-test-command",
            include: ["wait 3 seconds", "send delayed test reply"],
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-test-command skips non-/test events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-test-command skips non-test Telegram events",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-non-test-command",
            params: {
              automationEvent: telegramMessageEvent({
                id: "telegram:message:non-test-command",
                text: "/start",
              }),
              workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
            },
          }),

          then.telegram.noMessages(),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-non-test-command",
            status: "complete",
            output: { skipped: true, reason: "not-test-command" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
