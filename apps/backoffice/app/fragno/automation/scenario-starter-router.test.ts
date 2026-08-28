import { assert, describe, test, vi } from "vitest";

import { isWorkflowStepStartedControlPayload } from "@fragno-dev/workflows/step-emission-control";

import { and, eq, queryOnce } from "@tanstack/react-db";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";

import type { AutomationEvent } from "./contracts";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";

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

vi.mock("cloudflare:workers", () => ({
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
}));

import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "./workflow-route-runtime";

const telegramTestCommandEntry = getStaticMarketplaceEntry({
  slug: "telegram-test-command",
  version: "1.0.0",
});
if (!telegramTestCommandEntry) {
  throw new Error("Expected the built-in Telegram test command Marketplace entry.");
}

const TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION = {
  targetScope: { kind: "org", orgId: "org-1" },
  slug: "telegram-channel",
  version: "1.0.0",
} as const;

const marketplaceTelegramTestWorkspace = () =>
  backofficeFiles.workspaceStarter({
    "automations/telegram-test-command.workflow.js":
      telegramTestCommandEntry.files["automations/telegram-test-command.workflow.js"],
  });

const telegramTestCommandRoute = {
  id: "telegram-test-command",
  name: "Telegram /test command",
  enabled: true,
  trigger: {
    kind: "event" as const,
    source: "telegram",
    eventType: "message.received",
    matcher: { path: "$.payload.text", op: "eq" as const, value: "/test" },
  },
  priority: 110,
  action: {
    kind: "start_workflow" as const,
    authority: { kind: "organization-automation" as const },
    workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
    instanceIdTemplate: "telegram-test-${event.id}",
  },
};

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
  actors: {
    initiator: {
      scope: "internal",
      type: "system",
      id: "scenario",
      role: "initiator",
    },
    principal: null,
    delegation: [],
  },
  subject: { orgId: "org-1" },
});

const waitForValue = async <T>(read: () => Promise<T | null>): Promise<T> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for synchronized workflow state.");
};

const settleTestCleanupWithin = async (
  operation: () => Promise<unknown>,
  timeoutMs = 1_000,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

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
    role: "initiator" as const,
  };

  return {
    id,
    scope: { kind: "org", orgId: "org-1" },
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      messageId: id,
      chatId,
      fromUserId: null,
      text,
    },
    actors: {
      initiator: actor,
      principal: null,
      delegation: [],
    },
    subject: { orgId: "org-1" },
  };
};

describe("starter automation router scenarios", () => {
  test("scenario TanStack DB helper drains and queries frontend-visible data", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario TanStack DB helper drains and queries frontend-visible data",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, when }) => [
          when.automation.ingestEvent(
            customAutomationEvent({
              id: "tanstack-event-1",
              payload: { ok: true },
            }),
          ),
          then.assert("assert event is visible through TanStack DB", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const event = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "tanstack-event-1"))
                .findOne(),
            );
            assert.equal(event?.source, "custom");
            assert.equal(event?.eventType, "thing.happened");
          }),
          when.automation.ingestEvent(
            customAutomationEvent({
              id: "tanstack-event-2",
              payload: { updated: true },
            }),
          ),
          then.assert("assert a started TanStack DB scope catches up", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const event = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "tanstack-event-2"))
                .findOne(),
            );
            assert.deepEqual(event?.payload, { updated: true });
          }),
        ],
      }),
    );
  });

  test("scenario TanStack DB exposes workflow state through the automation outbox", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario TanStack DB exposes automation workflow state",
        files: marketplaceTelegramTestWorkspace(),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, when }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            instanceId: "tanstack-workflow-run",
            path: "/workspace/automations/telegram-test-command.workflow.js",
            event: telegramMessageEvent({
              id: "tanstack-workflow-event",
              text: "/test",
            }),
          }),
          then.assert("assert workflow instance and waiting step are visible", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();

            const instance = await queryOnce((query) =>
              query
                .from({ instance: database.collections.workflowInstances })
                .where(({ instance }) =>
                  and(
                    eq(instance.workflowName, "codemode-script"),
                    eq(instance.instanceId, "tanstack-workflow-run"),
                  ),
                )
                .findOne(),
            );
            assert(instance, "Expected the workflow instance to synchronize through TanStack DB.");
            assert.equal(instance.remoteWorkflowName, "telegram-test-command");
            assert.equal(instance.status, "waiting");

            const waitingStep = await queryOnce((query) =>
              query
                .from({ step: database.collections.workflowSteps })
                .where(({ step }) =>
                  and(eq(step.instanceRef, instance.id), eq(step.name, "wait 3 seconds")),
                )
                .findOne(),
            );
            assert(waitingStep, "Expected the workflow step to synchronize through TanStack DB.");
            assert.equal(waitingStep.type, "sleep");
            assert.equal(waitingStep.status, "waiting");
          }),
        ],
      }),
    );
  });

  test("scenario TanStack DB exposes an in-flight step.do lifecycle", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario TanStack DB exposes an in-flight step.do lifecycle",
        files: backofficeFiles.custom({
          workspace: {
            "automations/tanstack-live-step.workflow.js": `defineWorkflow(
  { name: "tanstack-live-step" },
  async (_event, step) => {
    await step.do("blocked operation", async (tx) => {
      await new Promise((resolve) => {
        tx.onEvent("release", (event) => {
          event.consume();
          resolve();
        });
      });
    });
  },
);`,
          },
        }),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("assert live step controls synchronize", async (ctx) => {
            const scope = { kind: "org" as const, orgId: "org-1" };
            const workflow = createRouteBackedAutomationWorkflowRuntime({
              object: ctx.runtime.objects.automations.forOrg(scope.orgId),
              execution: createBackofficeSystemExecution(scope),
            });
            const workflowPath = "/workspace/automations/tanstack-live-step.workflow.js";
            const event = customAutomationEvent({ id: "tanstack-live-step-event" });
            const prepared = prepareCodemodeWorkflowInstance({
              code: await ctx.files.forOrg("org-1").readFile(workflowPath, "utf-8"),
              filename: workflowPath,
              instanceId: "tanstack-live-step-run",
            });
            assert(prepared.remoteWorkflowName === "tanstack-live-step");
            const workflowInput = createCodemodeWorkflowInstanceInput({
              prepared,
              trigger: { type: "event", event },
              execution: createBackofficeSystemExecution(scope),
            });
            await workflow.createInternalInstance(workflowInput);

            const database = ctx.tanstack.automations.forOrg("org-1");
            const drainPromise = ctx.runtime.drain();
            let released = false;
            let drainCompleted = false;

            try {
              const activeEmission = await waitForValue(async () => {
                await database.sync();
                const instance = await queryOnce((query) =>
                  query
                    .from({ instance: database.collections.workflowInstances })
                    .where(({ instance }) =>
                      and(
                        eq(instance.workflowName, "codemode-script"),
                        eq(instance.instanceId, "tanstack-live-step-run"),
                      ),
                    )
                    .findOne(),
                );
                if (!instance) {
                  return null;
                }

                const emissions = await queryOnce((query) =>
                  query
                    .from({
                      emission: database.collections.workflowStepEmissions,
                    })
                    .where(({ emission }) => eq(emission.instanceRef, instance.id)),
                );
                return (
                  emissions.find(
                    (emission) =>
                      emission.actor === "system" &&
                      emission.stepKey === "do:blocked operation" &&
                      isWorkflowStepStartedControlPayload(emission.payload),
                  ) ?? null
                );
              });

              assert.equal(activeEmission.stepKey, "do:blocked operation");

              await workflow.sendInternalEvent({
                workflowName: "codemode-script",
                instanceId: "tanstack-live-step-run",
                type: "release",
                payload: null,
              });
              released = true;
              await drainPromise;
              drainCompleted = true;

              await database.sync();
              const completedStep = await queryOnce((query) =>
                query
                  .from({ step: database.collections.workflowSteps })
                  .where(({ step }) => eq(step.stepKey, "do:blocked operation"))
                  .findOne(),
              );
              assert.equal(completedStep?.status, "completed");

              const remainingEmissions = await queryOnce((query) =>
                query.from({
                  emission: database.collections.workflowStepEmissions,
                }),
              );
              assert.equal(remainingEmissions.length, 0);
            } finally {
              if (!released) {
                await settleTestCleanupWithin(() =>
                  workflow.sendInternalEvent({
                    workflowName: "codemode-script",
                    instanceId: "tanstack-live-step-run",
                    type: "release",
                    payload: null,
                  }),
                );
              }
              if (!drainCompleted) {
                await settleTestCleanupWithin(() => drainPromise);
              }
            }
          }),
        ],
      }),
    );
  });

  test("scenario router helpers inspect core and Marketplace channel routes", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router helpers inspect core and Marketplace channel routes",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.router.seedStarter({ orgId: "org-1" }),

          then.router.routes({
            orgId: "org-1",
            include: [
              {
                id: "system-project-files-configure",
                action: {
                  kind: "start_workflow",
                  authority: { kind: "organization-automation" },
                  workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
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
            ],
          }),
          then.router.route({
            orgId: "org-1",
            id: "telegram-pi-linking",
            enabled: true,
            priority: 120,
            trigger: { kind: "event" },
          }),
          then.assert(
            "assert core and channel routes are visible through TanStack DB",
            async (ctx) => {
              const database = ctx.tanstack.automations.forOrg("org-1");
              await database.drain();
              const routes = await queryOnce((query) =>
                query.from({ route: database.collections.routes }),
              );
              const expectedIds = [
                "system-project-files-configure",
                "telegram-identity-claim-completed",
              ];
              const missing = expectedIds.filter(
                (expectedId) => !routes.some((route) => route.id === expectedId),
              );
              assert.equal(missing.length, 0);
            },
          ),
          then.router.missing({ orgId: "org-1", id: "no-such-route" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("disabling a custom route stops it from starting workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router disables custom route",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),
          when.router.createRoute({ orgId: "org-1", ...telegramTestCommandRoute }),
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

  test("updating a custom route matcher changes which events start it", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router updates starter matcher",

        files: marketplaceTelegramTestWorkspace(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),
          when.router.createRoute({ orgId: "org-1", ...telegramTestCommandRoute }),
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
    const automationEvent = event;
    await step.do("store custom route hit", async () => {
      await store.set({
        key: "custom/" + automationEvent.id,
        value: automationEvent.payload.kind,
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
              authority: { kind: "organization-automation" },
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
            customAutomationEvent({
              id: "alpha-1",
              payload: { kind: "alpha" },
            }),
          ),
          when.automation.ingestEvent(
            customAutomationEvent({ id: "beta-1", payload: { kind: "beta" } }),
          ),

          then.assert("assert automation events are visible through TanStack DB", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const alphaEvent = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "alpha-1"))
                .findOne(),
            );
            const betaEvent = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "beta-1"))
                .findOne(),
            );
            assert.deepEqual(alphaEvent?.payload, { kind: "alpha" });
            assert.deepEqual(betaEvent?.payload, { kind: "beta" });
          }),

          then.workflow.instance({
            remoteWorkflowName: "custom-alpha",
            instanceId: "custom-alpha-alpha-1",
            status: "complete",
            actors: {
              initiator: {
                scope: "internal",
                type: "system",
                id: "scenario",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "automation",
                id: "automation-route:custom-alpha",
                role: "principal",
              },
              delegation: [],
            },
            output: { eventId: "alpha-1", kind: "alpha" },
          }),
          then.workflow.missing({
            remoteWorkflowName: "custom-alpha",
            instanceId: "custom-alpha-beta-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "custom/alpha-1",
            value: "alpha",
          }),
          then.assert(
            "assert custom workflow store output is visible through TanStack DB",
            async (ctx) => {
              const database = ctx.tanstack.automations.forOrg("org-1");
              await database.drain();
              const entry = await queryOnce((query) =>
                query
                  .from({ entry: database.collections.kvStore })
                  .where(({ entry }) => eq(entry.key, "custom/alpha-1"))
                  .findOne(),
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

  test("a broken start_workflow route does not block another matched route", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario router missing workflow file skips",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/valid-matched-route.workflow.js",
            content: `defineWorkflow(
  { name: "valid-matched-route" },
  async (event) => ({ eventId: event.id }),
);`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "missing-workflow-file",
            name: "Missing workflow file",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: {
                path: "$.payload.kind",
                op: "eq",
                value: "missing-file",
              },
            },
            priority: 50,
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation" },
              workflowScriptPath: "/workspace/automations/missing-workflow-file.workflow.js",
              instanceIdTemplate: "missing-workflow-file-${event.id}",
            },
          }),
          given.router.route({
            orgId: "org-1",
            id: "valid-matched-route",
            name: "Valid matched route",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: {
                path: "$.payload.kind",
                op: "eq",
                value: "missing-file",
              },
            },
            priority: 60,
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation" },
              workflowScriptPath: "/workspace/automations/valid-matched-route.workflow.js",
              instanceIdTemplate: "valid-matched-route-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            customAutomationEvent({
              id: "missing-file-1",
              payload: { kind: "missing-file" },
            }),
          ),

          then.workflow.missing({
            remoteWorkflowName: "missing-workflow-file",
            instanceId: "missing-workflow-file-missing-file-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "valid-matched-route",
            instanceId: "valid-matched-route-missing-file-1",
            status: "complete",
            output: { eventId: "missing-file-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("a failed fan-out retries after its missing workflow is created without duplicating a forwarded event", async () => {
    const event = customAutomationEvent({
      id: "fanout-retry-1",
      eventType: "fanout.retry",
      payload: { value: "ready" },
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "retry failed route fan-out after creating its workflow target",

        files: backofficeFiles.workspaceStarter(),
        vars: () => ({ firstAttemptAt: "" }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/fanout-retry-waiter.workflow.js",
            content: `defineWorkflow(
  { name: "fanout-retry-waiter" },
  async (_event, step) => {
    const signal = await step.waitForEvent("route signal", {
      type: "fanout-ready",
      timeout: "15 minutes",
    });
    return { received: signal.payload.payload.value };
  },
);`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "fanout-send-to-late-workflow",
            name: "Send to a workflow created after the first attempt",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "fanout.retry",
              matcher: { path: "$.scope.kind", op: "eq", value: "org" },
            },
            priority: 50,
            action: {
              kind: "send_workflow_event",
              target: { kind: "instance_id", template: "fanout-retry-waiter-1" },
              eventType: "fanout-ready",
              payload: "$event",
            },
          }),
          given.router.route({
            orgId: "org-1",
            id: "fanout-forward-success",
            name: "Forward successfully before the sibling route is retried",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "fanout.retry",
              matcher: { path: "$.scope.kind", op: "eq", value: "org" },
            },
            priority: 60,
            action: {
              kind: "forward_event",
              targetScope: {
                kind: "project",
                orgIdTemplate: "org-1",
                projectIdTemplate: "fanout-retry-project",
              },
              idTemplate: "forwarded-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(event),

          then.assert("the first fan-out attempt is waiting to retry", async (ctx) => {
            const queue = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.getDurableHookQueue("automation", { pageSize: 100 });
            const hook = queue.items.find(
              (item) =>
                item.hookName === "internalIngestEvent" &&
                (item.payload as { event?: { id?: string } }).event?.id === event.id,
            );
            assert(hook);
            assert.equal(hook.status, "pending");
            assert.equal(hook.attempts, 1);
            assert.equal(hook.error, "INSTANCE_NOT_FOUND");
            assert(hook.lastAttemptAt);
            ctx.vars.firstAttemptAt = hook.lastAttemptAt;
          }),

          then.automation.event({
            scope: {
              kind: "project",
              orgId: "org-1",
              projectId: "fanout-retry-project",
            },
            where: { id: "forwarded-fanout-retry-1" },
            expected: {
              source: "custom",
              eventType: "fanout.retry",
              payload: { value: "ready" },
            },
          }),

          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "fanout-retry-waiter",
            instanceId: "fanout-retry-waiter-1",
            path: "/workspace/automations/fanout-retry-waiter.workflow.js",
            event: customAutomationEvent({ id: "fanout-retry-waiter-bootstrap" }),
          }),
          then.workflow.instance({
            remoteWorkflowName: "fanout-retry-waiter",
            instanceId: "fanout-retry-waiter-1",
            status: "waiting",
            waitingFor: "fanout-ready",
          }),

          when.time.advance("1 second"),

          then.workflow.instance({
            remoteWorkflowName: "fanout-retry-waiter",
            instanceId: "fanout-retry-waiter-1",
            status: "complete",
            output: { received: "ready" },
          }),
          then.assert("the retry completed without forwarding the event twice", async (ctx) => {
            const sourceQueue = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.getDurableHookQueue("automation", { pageSize: 100 });
            const sourceHook = sourceQueue.items.find(
              (item) =>
                item.hookName === "internalIngestEvent" &&
                (item.payload as { event?: { id?: string } }).event?.id === event.id,
            );
            assert(sourceHook);
            assert.equal(sourceHook.status, "completed");
            assert(sourceHook.lastAttemptAt);
            assert.notEqual(sourceHook.lastAttemptAt, ctx.vars.firstAttemptAt);

            const response = await ctx.runtime.objects.automations
              .forProject({ orgId: "org-1", projectId: "fanout-retry-project" })
              .http.fetch(new Request("https://automations.test/api/automations/events?limit=100"));
            assert(response.ok);
            const result = (await response.json()) as { events: Array<{ id: string }> };
            assert.equal(
              result.events.filter(({ id }) => id === "forwarded-fanout-retry-1").length,
              1,
            );
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
          then.hooks.noPending({ orgId: "org-1", fragments: ["automations"] }),
          then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
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
        category: ["test", "router"],
      });
    });
    return { received: signalEvent.payload.value };
  },
);
`,
          }),
          given.store.entry({
            orgId: "org-1",
            key: "waiter/alpha",
            value: "waiter-1",
          }),
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
              target: {
                kind: "stored_instance_id",
                keyTemplate: "waiter/${event.payload.key}",
              },
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
            path: "/workspace/automations/custom-waiter.workflow.js",
            event: customAutomationEvent({ id: "waiter-bootstrap" }),
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
          then.store.entry({
            orgId: "org-1",
            key: "signal/alpha",
            value: "delivered",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi creates a Pi session for an authorized linked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Telegram Channel /pi creates a Pi session",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "openai::gpt-5-mini",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),
          then.identity.resolves({
            scope: { kind: "org", orgId: "org-1" },
            identity: {
              scope: "external",
              source: "telegram",
              type: "chat",
              id: "1001",
            },
            userId: "user-1",
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_001,
            messageId: 601,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.automation.event({
            scope: { kind: "org", orgId: "org-1" },
            where: {
              source: "telegram",
              eventType: "message.received",
            },
            expected: {
              actors: {
                initiator: {
                  scope: "external",
                  source: "telegram",
                  type: "chat",
                  id: "1001",
                  role: "initiator",
                },
                principal: null,
                delegation: [],
              },
              subject: null,
            },
          }),
          then.pi.createdSession({
            model: { provider: "openai", name: "gpt-5-mini" },
            name: "Telegram 1001",
            sessionId: "pi-session-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-1",
          }),
          then.kernel.action({
            operation: BACKOFFICE_PERMISSION.store.modify,
            scope: { kind: "org", orgId: "org-1" },
            actors: {
              initiator: {
                scope: "external",
                source: "telegram",
                type: "chat",
                id: "1001",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "automation",
                role: "principal",
              },
            },
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Created Pi session: pi-session-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            params: {
              trigger: {
                type: "event",
                event: {
                  actors: {
                    initiator: {
                      scope: "external",
                      source: "telegram",
                      type: "chat",
                      id: "1001",
                      role: "initiator",
                    },
                    principal: null,
                    delegation: [],
                  },
                },
              },
            },
            output: { sessionId: "pi-session-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi creates a session for a fresh organization without stored Pi configuration", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Telegram Channel /pi uses the environment-backed default model",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_004,
            messageId: 604,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.pi.createdSession({
            model: { provider: "openai", name: "gpt-5-mini" },
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

  test("Telegram identity revocation returns the Pi workflow to unlinked behavior", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "revoked Telegram identity is unlinked in the Pi workflow",
        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),
        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],
        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.identity.revoke({
            orgId: "org-1",
            externalId: "1001",
            expectedUserId: "user-1",
          }),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_005,
            messageId: 605,
            chatId: "1001",
            text: "/pi",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called after identity revocation", (ctx) => {
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

  test("Telegram /pi skips an unlinked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Telegram Channel /pi skips an unlinked chat",

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
            value: "openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
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
        name: "Telegram Channel text skips an unlinked chat",

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
            value: "openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
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
        name: "Telegram Channel slash command is ignored",

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
            value: "openai::gpt-5-mini",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_008,
            messageId: 608,
            chatId: "1001",
            text: "/help",
            from: { id: 2_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-linking",
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-test-command",
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-pi-linking",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("raw Telegram webhooks without messages do not create starter workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter raw Telegram webhook without message is ignored",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.telegram.webhook({
            orgId: "org-1",
            label: "receive Telegram webhook without a message",
            update: {
              update_id: 21_001,
              my_chat_member: {
                chat: { id: 1001, type: "private" },
                from: { id: 2001, is_bot: false, first_name: "Ada" },
                date: 1_780_000_000,
                old_chat_member: {
                  status: "member",
                  user: { id: 123, is_bot: true },
                },
                new_chat_member: {
                  status: "kicked",
                  user: { id: 123, is_bot: true },
                },
              },
            },
          }),

          then.telegram.noMessages(),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-linking",
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-test-command",
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-pi-linking",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("telegram-user-pi-linking skips slash commands other than /pi", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram-user-pi-linking skips unrelated slash commands",

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
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-unrelated-command",
            path: "/workspace/automations/telegram-user-pi-linking.workflow.js",
            event: telegramMessageEvent({
              id: "telegram:message:unrelated-pi-command",
              text: "/help",
            }),
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
        name: "Telegram Channel text reuses a Pi session",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "openai::gpt-5-mini",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

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
            model: { provider: "openai", name: "gpt-5-mini" },
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
            include: [{ key: "telegram-pi-session/user-1", value: "pi-session-1" }],
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
        name: "Telegram Channel /pi reuses an active Pi session",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "openai::gpt-5-mini",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

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
        name: "Telegram Channel /pi replaces a missing stored Pi session",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "openai::gpt-5-mini",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram-pi-session/user-1",
            value: "pi-session-missing",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

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
            model: { provider: "openai", name: "gpt-5-mini" },
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
          name: `Telegram Channel /pi replaces a ${status} Pi session`,

          fakes: ({ fake }) => ({
            telegram: fake.telegram(),
            pi: fake.pi(),
          }),

          setup: ({ given }) => [
            given.auth.user({
              id: "owner-1",
              email: "owner@example.com",
            }),
            given.auth.user({
              id: "user-1",
              email: "linked-user@example.com",
            }),
            given.auth.organization({
              id: "org-1",
              name: "Ada Labs",
              ownerUserId: "owner-1",
              ownerRoles: ["owner"],
            }),
            given.auth.member({
              orgId: "org-1",
              userId: "user-1",
              roles: ["member"],
            }),
            given.organization.exists({
              id: "org-1",
              name: "Ada Labs",
              ownerUserId: "owner-1",
            }),
            given.telegram.configured({
              orgId: "org-1",
              botUsername: "fragno_bot",
            }),
            given.pi.defaultAgent({
              orgId: "org-1",
              value: "openai::gpt-5-mini",
            }),
            given.identity.binding({
              orgId: "org-1",
              externalId: "1001",
              userId: "user-1",
            }),
          ],

          steps: ({ when, then }) => [
            when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
            then.auth.authority({
              userId: "user-1",
              orgId: "org-1",
              expected: {
                active: true,
                role: "user",
                organizationMember: true,
              },
            }),
            then.auth.member({
              orgId: "org-1",
              userId: "user-1",
              roles: ["member"],
            }),
            then.auth.permissions({
              userId: "user-1",
              scope: { kind: "org", orgId: "org-1" },
              include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
              exclude: [BACKOFFICE_PERMISSION.identity.bind],
            }),

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
        name: "Telegram Channel text sends no message when Pi has no assistant text",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi({ assistantText: () => "" }),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.pi.defaultAgent({
            orgId: "org-1",
            value: "openai::gpt-5-mini",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

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
        name: "Telegram Channel /test waits before sending a reply",

        files: marketplaceTelegramTestWorkspace(),

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
          when.router.createRoute({ orgId: "org-1", ...telegramTestCommandRoute }),
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
            instanceId: "telegram-test-message-20005",
            status: "waiting",
            params: {
              trigger: {
                type: "event",
                event: {
                  source: "telegram",
                  eventType: "message.received",
                  payload: {
                    chatId: "1001",
                    text: "/test",
                  },
                  actors: {
                    initiator: {
                      scope: "external",
                      source: "telegram",
                      type: "chat",
                      id: "1001",
                      role: "initiator",
                    },
                    principal: null,
                    delegation: [],
                  },
                },
              },
              program: {
                workflowName: "telegram-test-command",
                filename: "/workspace/automations/telegram-test-command.workflow.js",
              },
            },
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
            instanceId: "telegram-test-message-20005",
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

        files: marketplaceTelegramTestWorkspace(),

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
            path: "/workspace/automations/telegram-test-command.workflow.js",
            event: telegramMessageEvent({
              id: "telegram:message:non-test-command",
              text: "/start",
            }),
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
