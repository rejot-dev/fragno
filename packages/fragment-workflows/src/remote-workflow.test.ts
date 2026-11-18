import { assert, describe, expect, expectTypeOf, test } from "vitest";

import { schema } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { getDurableHooksService, withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import {
  resolveRemoteWorkflowHookIntent,
  type RemoteWorkflowAllowedHook,
  type RemoteWorkflowStepHost,
} from "./remote-workflow";
import { runRemotely } from "./remote-workflow-test-client";
import { defineScenario, runScenario } from "./scenario";
import { createWorkflowsTestHarness } from "./test";
import {
  NonRetryableError,
  defineRemoteWorkflow,
  defineWorkflow,
  type WorkflowOutputFromEntry,
  type WorkflowParamsFromEntry,
} from "./workflow";

const remoteHookTestSchema = schema("remote-hook-test", (s) => s);
const remoteHookTestFragment = defineFragment("remote-hook-test")
  .extend(withDatabase(remoteHookTestSchema))
  .provideHooks(({ defineHook }) => ({
    onRemoteOutcome: defineHook(async function () {}),
    onRemoteRetryOutcome: defineHook(async function () {}),
    onRemoteStepRecorded: defineHook(async function () {}),
  }))
  .build();

test("defineRemoteWorkflow infers input and output schema types", () => {
  const RemoteWorkflow = defineRemoteWorkflow(
    {
      name: "typed-remote-workflow",
      schema: z.object({ requestId: z.string() }),
      outputSchema: z.object({ accepted: z.boolean() }),
    },
    async (event) => {
      expectTypeOf(event.payload).toExtend<{ requestId: string }>();
      return { accepted: event.payload.requestId.length > 0 };
    },
  );

  expectTypeOf<WorkflowParamsFromEntry<typeof RemoteWorkflow>>().toEqualTypeOf<{
    requestId: string;
  }>();
  expectTypeOf<WorkflowOutputFromEntry<typeof RemoteWorkflow>>().toEqualTypeOf<{
    accepted: boolean;
  }>();

  const validParams: WorkflowParamsFromEntry<typeof RemoteWorkflow> = { requestId: "request-1" };
  // @ts-expect-error schema output requires a string requestId
  const invalidParams: WorkflowParamsFromEntry<typeof RemoteWorkflow> = { requestId: 1 };
  void validParams;
  void invalidParams;
});

test("defineRemoteWorkflow accepts an output schema without an input schema", () => {
  const RemoteWorkflow = defineRemoteWorkflow(
    {
      name: "typed-remote-output-workflow",
      outputSchema: z.object({ accepted: z.boolean() }),
    },
    async () => ({ accepted: true }),
  );

  expectTypeOf<WorkflowOutputFromEntry<typeof RemoteWorkflow>>().toEqualTypeOf<{
    accepted: boolean;
  }>();

  // @ts-expect-error output schema requires a boolean accepted value
  const invalidOutput: WorkflowOutputFromEntry<typeof RemoteWorkflow> = { accepted: "yes" };
  void invalidOutput;
});

/** Records one hook the way remote code asks for it: by target, resolved against the host's grants. */
async function recordRemoteHook(
  remote: RemoteWorkflowStepHost,
  allowedHooks: readonly RemoteWorkflowAllowedHook[],
  target: string,
) {
  return await runRemotely(
    remote,
    async (step) =>
      await step.do("shared", undefined, (tx) => {
        tx.triggerHook(
          resolveRemoteWorkflowHookIntent(
            {
              target,
              schemaName: remoteHookTestSchema.name,
              hookName: "onRemoteStepRecorded",
              payload: { step: "shared" },
              when: "both",
            },
            allowedHooks,
          ),
        );
        return "recorded";
      }),
  );
}

describe("remote workflow step host", () => {
  test("remote hook intents follow successful and terminal step outcomes", async () => {
    const HookWorkflow = defineRemoteWorkflow<"remote-hook-outcomes", { fail: boolean }>(
      { name: "remote-hook-outcomes" },
      async (event, host) =>
        await runRemotely(host, async (step) => {
          await step.do("record hook", undefined, async (tx) => {
            if (!event.payload.fail) {
              tx.mutate(({ forSchema }) => {
                forSchema(remoteHookTestSchema).triggerHook("onRemoteOutcome", {
                  instanceId: event.instanceId,
                  source: "local-before",
                });
              });
            }
            tx.triggerHook({
              namespace: "custom-hook-namespace",
              hookName: "onRemoteOutcome",
              payload: { instanceId: event.instanceId, source: "remote" },
              when: "both",
            });
            if (event.payload.fail) {
              throw new NonRetryableError("REMOTE_STEP_FAILED");
            }
            tx.mutate(({ forSchema }) => {
              forSchema(remoteHookTestSchema).triggerHook("onRemoteOutcome", {
                instanceId: event.instanceId,
                source: "local-after",
              });
            });
          });
        }),
    );
    const workflows = { HOOK: HookWorkflow };

    await runScenario(
      defineScenario({
        name: "remote-hook-outcomes",
        workflows,
        harness: {
          configureBuilder: (builder) =>
            builder.withFragment(
              "remoteHooks",
              instantiate(remoteHookTestFragment).withOptions({
                databaseNamespace: "custom-hook-namespace",
              }),
            ),
        },
        steps: ({ runner, workflow }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "HOOK",
            id: "remote-hook-success",
            params: { fail: false },
            remoteWorkflowName: "remote-hook-body",
          }),
          runner.initializeAndRunUntilIdle({
            workflow: "HOOK",
            id: "remote-hook-failure",
            params: { fail: true },
            remoteWorkflowName: "remote-hook-body",
          }),
          runner.runCreateUntilIdle({ workflow: "HOOK", instanceId: "remote-hook-success" }),
          workflow.read({
            read: async (ctx) => ({
              success: await ctx.state.getStatus("HOOK", "remote-hook-success"),
              failure: await ctx.state.getStatus("HOOK", "remote-hook-failure"),
              hooks: await ctx.state.internal.getHooks({
                namespace: "custom-hook-namespace",
                hookName: "onRemoteOutcome",
              }),
            }),
            assert: ({ success, failure, hooks }) => {
              assert(success.status === "complete");
              assert(failure.status === "errored");
              expect(
                hooks
                  .toSorted((left, right) => Number(left.id - right.id))
                  .map((hook) => hook.payload),
              ).toEqual([
                { instanceId: "remote-hook-success", source: "local-before" },
                { instanceId: "remote-hook-success", source: "remote" },
                { instanceId: "remote-hook-success", source: "local-after" },
                { instanceId: "remote-hook-failure", source: "remote" },
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("remote hook intent is not persisted on a retryable attempt", async () => {
    const RetryWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-retry" },
      async (_event, host) =>
        await runRemotely(host, async (step) => {
          await step.do("retry", { retries: { limit: 1, delay: "1 hour" } }, async (tx) => {
            tx.triggerHook({
              namespace: "remote_hook_test",
              hookName: "onRemoteRetryOutcome",
              payload: { result: "terminal" },
              when: "both",
            });
            throw new Error("RETRY_LATER");
          });
        }),
    );
    const workflows = { RETRY: RetryWorkflow };

    await runScenario(
      defineScenario({
        name: "remote-hook-retry",
        workflows,
        harness: {
          configureBuilder: (builder) =>
            builder.withFragment("remoteHooks", instantiate(remoteHookTestFragment)),
        },
        steps: ({ runner, workflow }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "RETRY",
            id: "remote-retry-1",
            remoteWorkflowName: "remote-retry-body",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("RETRY", "remote-retry-1"),
              hooks: await ctx.state.internal.getHooks({
                namespace: "remote_hook_test",
                hookName: "onRemoteRetryOutcome",
              }),
            }),
            assert: ({ status, hooks }) => {
              assert(status.status === "waiting");
              expect(hooks).toEqual([]);
            },
          }),
          runner.advanceTimeAndRunUntilIdle({
            workflow: "RETRY",
            instanceId: "remote-retry-1",
            advanceBy: "2 hours",
          }),
          runner.tick({ workflow: "RETRY", instanceId: "remote-retry-1", reason: "retry" }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("RETRY", "remote-retry-1"),
              hooks: await ctx.state.internal.getHooks({
                namespace: "remote_hook_test",
                hookName: "onRemoteRetryOutcome",
              }),
            }),
            assert: ({ status, hooks }) => {
              assert(status.status === "errored");
              expect(hooks.map((hook) => hook.payload)).toEqual([{ result: "terminal" }]);
            },
          }),
        ],
      }),
    );
  });

  test("remote step tx can create another workflow instance", async () => {
    const ChildWorkflow = defineWorkflow<
      "remote-child-workflow",
      { value: number },
      { value: number }
    >({ name: "remote-child-workflow" }, async (event) => ({ value: event.payload.value }));
    const ParentWorkflow = defineRemoteWorkflow(
      { name: "remote-parent-workflow" },
      async (_event, host) =>
        await runRemotely(host, async (step) => {
          await step.do("create-child", undefined, async (tx) => {
            tx.workflowServiceCalls(() => [
              {
                type: "createInstance",
                workflowName: "remote-child-workflow",
                instanceId: "remote-child-from-step",
                params: { value: 42 },
              },
            ]);
          });
          return { childId: "remote-child-from-step" };
        }),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { PARENT: ParentWorkflow, CHILD: ChildWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const parentId = await harness.createInstance("PARENT", {
      id: "remote-parent-1",
      remoteWorkflowName: "remote-parent-body",
    });
    await harness.runUntilIdle({
      workflowName: "remote-parent-workflow",
      instanceId: parentId,
      reason: "create",
    });

    await expect(harness.getStatus("PARENT", parentId)).resolves.toMatchObject({
      status: "complete",
      output: { childId: "remote-child-from-step" },
    });
    await expect(harness.getStatus("CHILD", "remote-child-from-step")).resolves.toMatchObject({
      status: "active",
    });
  });

  test("remote step tx can create an event for another workflow instance", async () => {
    const ParentWorkflow = defineWorkflow(
      { name: "remote-event-parent-workflow" },
      async (_event, step) => {
        const child = await step.waitForEvent<{ value: number }>("join child", {
          type: "child:complete",
        });
        return { value: child.payload.value };
      },
    );
    const RemoteChildWorkflow = defineRemoteWorkflow<
      "remote-event-child-workflow",
      { parentId: string; value: number },
      { completed: true }
    >(
      { name: "remote-event-child-workflow" },
      async (event, host) =>
        await runRemotely(host, async (step) => {
          await step.do("complete child", undefined, async (tx) => {
            tx.workflowServiceCalls(() => [
              {
                type: "createEvent",
                workflowName: "remote-event-parent-workflow",
                instanceId: event.payload.parentId,
                eventId: `${event.instanceId}:complete`,
                eventType: "child:complete",
                payload: { value: event.payload.value },
              },
            ]);
          });
          return { completed: true };
        }),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { PARENT: ParentWorkflow, CHILD: RemoteChildWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const parentId = await harness.createInstance("PARENT", { id: "remote-event-parent-1" });
    await harness.runUntilIdle({
      workflowName: "remote-event-parent-workflow",
      instanceId: parentId,
      reason: "create",
    });
    await expect(harness.getStatus("PARENT", parentId)).resolves.toMatchObject({
      status: "waiting",
    });

    const childId = await harness.createInstance("CHILD", {
      id: "remote-event-child-1",
      params: { parentId, value: 42 },
      remoteWorkflowName: "remote-event-child-body",
    });
    await harness.runUntilIdle({
      workflowName: "remote-event-child-workflow",
      instanceId: childId,
      reason: "create",
    });

    await expect(harness.getStatus("CHILD", childId)).resolves.toMatchObject({
      status: "complete",
      output: { completed: true },
    });
    await expect(harness.getHistory("PARENT", parentId)).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          id: "remote-event-child-1:complete",
          type: "child:complete",
          payload: { value: 42 },
        }),
      ],
    });

    await harness.runUntilIdle({
      workflowName: "remote-event-parent-workflow",
      instanceId: parentId,
      reason: "event",
    });
    await expect(harness.getStatus("PARENT", parentId)).resolves.toMatchObject({
      status: "complete",
      output: { value: 42 },
    });
  });

  test("a remote race keeps its winner when outcomes reach the remote code out of order", async () => {
    const winners: string[] = [];
    const RaceWorkflow = defineRemoteWorkflow(
      { name: "remote-race" },
      async (_event, host) =>
        await runRemotely(
          host,
          async (step) => {
            const winner = await Promise.race([
              step.do("first", undefined, () => "first"),
              step.do("second", undefined, () => "second"),
            ]);
            winners.push(winner);
            await step.sleep("pause", "1 hour");
            return winner;
          },
          // "first" settles first on the host, but its outcome reaches the remote code last.
          async (name, outcome) => {
            if (name === "first") {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            return outcome;
          },
        ),
    );
    const result = await runScenario(
      defineScenario({
        name: "remote-race",
        workflows: { RACE: RaceWorkflow },
        harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
        steps: ({ runner, workflow }) => [
          workflow.create({ workflow: "RACE", id: "race-1", remoteWorkflowName: "race-body" }),
          runner.drainHooks(),
          runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("RACE", "race-1"),
            storeAs: "status",
          }),
        ],
      }),
    );

    expect(winners).toEqual(["first", "first"]);
    expect(result.vars["status"]).toMatchObject({ status: "complete", output: "first" });
  });

  test("remote code that awaits something other than a step errors the run", async () => {
    const StalledWorkflow = defineRemoteWorkflow(
      { name: "remote-stalled" },
      async (_event, host) =>
        await runRemotely(host, async (step) => {
          await step.do("before", undefined, () => "before");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await step.do("after", undefined, () => "after");
        }),
    );
    const result = await runScenario(
      defineScenario({
        name: "remote-stalled",
        workflows: { STALLED: StalledWorkflow },
        harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
        steps: ({ runner, workflow }) => [
          workflow.create({
            workflow: "STALLED",
            id: "stalled-1",
            remoteWorkflowName: "stalled-body",
          }),
          runner.drainHooks(),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("STALLED", "stalled-1"),
            storeAs: "status",
          }),
        ],
      }),
    );

    expect(result.vars["status"]).toMatchObject({
      status: "errored",
      error: { name: "WorkflowStalledError" },
    });
  });

  test("remote code cannot catch a step outcome its transport lost", async () => {
    const LostWorkflow = defineRemoteWorkflow(
      { name: "remote-lost" },
      async (_event, host) =>
        await runRemotely(
          host,
          async (step) => {
            try {
              return await step.do("charge", undefined, () => "charged");
            } catch {
              return "not charged";
            }
          },
          async () => {
            throw new Error("TRANSPORT_LOST");
          },
        ),
    );
    const result = await runScenario(
      defineScenario({
        name: "remote-lost",
        workflows: { LOST: LostWorkflow },
        harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
        steps: ({ runner, workflow }) => [
          workflow.create({ workflow: "LOST", id: "lost-1", remoteWorkflowName: "lost-body" }),
          runner.drainHooks(),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("LOST", "lost-1"),
            storeAs: "status",
          }),
        ],
      }),
    );

    expect(result.vars["status"]).toMatchObject({
      status: "errored",
      error: { message: "TRANSPORT_LOST" },
    });
  });

  test("rejects unlisted remote hooks before committing a step", async () => {
    const DeniedWorkflow = defineRemoteWorkflow(
      { name: "worker-remote-hook-denied" },
      async (_event, remote) =>
        await recordRemoteHook(
          remote,
          [
            {
              target: "tenant",
              schemaName: remoteHookTestSchema.name,
              hookName: "onRemoteOutcome",
              namespace: "remote_hook_test",
            },
          ],
          "tenant",
        ),
    );

    await runScenario(
      defineScenario({
        name: "worker-remote-hook-denied",
        workflows: { DENIED: DeniedWorkflow },
        harness: {
          configureBuilder: (builder) =>
            builder.withFragment("remoteHooks", instantiate(remoteHookTestFragment)),
        },
        steps: ({ runner, workflow }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "DENIED",
            id: "worker-remote-denied-1",
            remoteWorkflowName: "worker-thread-body",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("DENIED", "worker-remote-denied-1"),
              hooks: await ctx.state.internal.getHooks({
                namespace: "remote_hook_test",
                hookName: "onRemoteStepRecorded",
              }),
            }),
            assert: ({ status, hooks }) => {
              expect(status).toMatchObject({
                status: "errored",
                error: {
                  message:
                    "REMOTE_WORKFLOW_HOOK_NOT_ALLOWED: tenant/remote-hook-test/onRemoteStepRecorded",
                },
              });
              expect(hooks).toEqual([]);
            },
          }),
        ],
      }),
    );
  });

  test.each([
    ["shared schema object", true],
    ["distinct schema objects", false],
  ] as const)("routes remote hooks to the selected mount with %s", async (_label, sharedSchema) => {
    const otherSchema = sharedSchema
      ? remoteHookTestSchema
      : schema(remoteHookTestSchema.name, (s) => s);
    const otherFragment = defineFragment("remote-hook-other")
      .extend(withDatabase(otherSchema))
      .provideHooks(({ defineHook }) => ({
        onRemoteStepRecorded: defineHook(async function () {}),
      }))
      .build();
    const tenantAHooks: RemoteWorkflowAllowedHook[] = [];
    const tenantBHooks: RemoteWorkflowAllowedHook[] = [];
    const TenantAWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-tenant-a" },
      async (_event, remote) => await recordRemoteHook(remote, tenantAHooks, "tenant-a"),
    );
    const TenantBWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-tenant-b" },
      async (_event, remote) => await recordRemoteHook(remote, tenantBHooks, "tenant-b"),
    );
    const CrossTenantWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-cross-tenant" },
      async (_event, remote) => await recordRemoteHook(remote, tenantAHooks, "tenant-b"),
    );
    const AmbiguousTargetWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-ambiguous-target" },
      async (_event, remote) =>
        await recordRemoteHook(
          remote,
          [...tenantAHooks, ...tenantBHooks.map((hook) => ({ ...hook, target: "tenant-a" }))],
          "tenant-a",
        ),
    );

    await runScenario(
      defineScenario({
        name: `remote-hook-mounts-${sharedSchema ? "shared" : "distinct"}`,
        workflows: {
          TENANT_A: TenantAWorkflow,
          TENANT_B: TenantBWorkflow,
          CROSS_TENANT: CrossTenantWorkflow,
          AMBIGUOUS_TARGET: AmbiguousTargetWorkflow,
        },
        harness: {
          configureBuilder: (builder) =>
            builder
              .withFragment(
                "tenantA",
                instantiate(remoteHookTestFragment).withOptions({
                  databaseNamespace: "tenant-a-hooks",
                  mountRoute: "/test/tenant-a",
                }),
              )
              .withFragment(
                "tenantB",
                instantiate(otherFragment).withOptions({
                  databaseNamespace: "tenant-b-hooks",
                  mountRoute: "/test/tenant-b",
                }),
              ),
        },
        steps: ({ runner, workflow }) => [
          workflow.read({
            read: (ctx) => ({
              tenantA: getDurableHooksService(ctx.harness.fragments["tenantA"].fragment).namespace,
              tenantB: getDurableHooksService(ctx.harness.fragments["tenantB"].fragment).namespace,
            }),
            assert: ({ tenantA, tenantB }) => {
              expect(tenantA).toBe("tenant-a-hooks");
              expect(tenantB).toBe("tenant-b-hooks");
              tenantAHooks.push({
                target: "tenant-a",
                schemaName: remoteHookTestSchema.name,
                hookName: "onRemoteStepRecorded",
                namespace: tenantA,
              });
              tenantBHooks.push({
                target: "tenant-b",
                schemaName: otherSchema.name,
                hookName: "onRemoteStepRecorded",
                namespace: tenantB,
              });
            },
          }),
          runner.initializeAndRunUntilIdle({
            workflow: "TENANT_A",
            id: "tenant-a-step",
            remoteWorkflowName: "worker-remote-body",
          }),
          runner.initializeAndRunUntilIdle({
            workflow: "TENANT_B",
            id: "tenant-b-step",
            remoteWorkflowName: "worker-remote-body",
          }),
          runner.initializeAndRunUntilIdle({
            workflow: "CROSS_TENANT",
            id: "cross-tenant-step",
            remoteWorkflowName: "worker-remote-body",
          }),
          runner.initializeAndRunUntilIdle({
            workflow: "AMBIGUOUS_TARGET",
            id: "ambiguous-target-step",
            remoteWorkflowName: "worker-remote-body",
          }),
          workflow.read({
            read: async (ctx) => ({
              tenantA: await ctx.state.internal.getHooks({
                namespace: "tenant-a-hooks",
                hookName: "onRemoteStepRecorded",
              }),
              tenantB: await ctx.state.internal.getHooks({
                namespace: "tenant-b-hooks",
                hookName: "onRemoteStepRecorded",
              }),
              crossTenant: await ctx.state.getStatus("CROSS_TENANT", "cross-tenant-step"),
              ambiguousTarget: await ctx.state.getStatus(
                "AMBIGUOUS_TARGET",
                "ambiguous-target-step",
              ),
            }),
            assert: ({ tenantA, tenantB, crossTenant, ambiguousTarget }) => {
              expect(tenantA).toEqual([expect.objectContaining({ payload: { step: "shared" } })]);
              expect(tenantB).toEqual([expect.objectContaining({ payload: { step: "shared" } })]);
              expect(crossTenant).toMatchObject({
                status: "errored",
                error: {
                  message:
                    "REMOTE_WORKFLOW_HOOK_NOT_ALLOWED: tenant-b/remote-hook-test/onRemoteStepRecorded",
                },
              });
              expect(ambiguousTarget).toMatchObject({
                status: "errored",
                error: {
                  message:
                    "REMOTE_WORKFLOW_HOOK_TARGET_AMBIGUOUS: tenant-a/remote-hook-test/onRemoteStepRecorded",
                },
              });
            },
          }),
        ],
      }),
    );
  });

  test("requires a remote workflow name when creating a remote workflow instance", async () => {
    const RemoteWorkflow = defineRemoteWorkflow({ name: "remote-required" }, async () => "done");
    const harness = await createWorkflowsTestHarness({
      workflows: { REMOTE: RemoteWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await expect(harness.createInstance("REMOTE", { id: "remote-required-1" })).rejects.toThrow(
      "WORKFLOW_REMOTE_NAME_REQUIRED",
    );
  });

  test("requires and stores a remote workflow name when batch creating remote instances", async () => {
    const RemoteWorkflow = defineRemoteWorkflow(
      { name: "remote-batch-required" },
      async () => "done",
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { REMOTE: RemoteWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await expect(harness.createBatch("REMOTE", [{ id: "remote-batch-1" }])).rejects.toThrow(
      "WORKFLOW_REMOTE_NAME_REQUIRED",
    );

    await expect(
      harness.createBatch("REMOTE", [{ id: "remote-batch-1" }, { id: "remote-batch-2" }], {
        remoteWorkflowName: "dynamic-batch-body",
      }),
    ).resolves.toHaveLength(2);
  });

  test("restart preserves the remote workflow name", async () => {
    const RemoteWorkflow = defineRemoteWorkflow(
      { name: "restart-remote-host" },
      async () => "done",
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { REMOTE: RemoteWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    try {
      await harness.createInstance("REMOTE", {
        id: "restart-remote-1",
        remoteWorkflowName: "dynamic-restart-body",
      });
      await harness.restartInstance("REMOTE", "restart-remote-1");

      const response = await harness.fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId",
        {
          pathParams: {
            workflowName: "restart-remote-host",
            instanceId: "restart-remote-1",
          },
        },
      );
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        details: { status: "active" },
        meta: { remoteWorkflowName: "dynamic-restart-body", runGeneration: 2 },
      });
    } finally {
      await harness.test.cleanup();
    }
  });

  test("still requires the registered workflow name when creating a remote instance", async () => {
    const RemoteWorkflow = defineRemoteWorkflow({ name: "registered-remote" }, async () => "done");
    const harness = await createWorkflowsTestHarness({
      workflows: { REMOTE: RemoteWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await expect(
      harness.createInstance("missing-remote", {
        id: "missing-remote-1",
        remoteWorkflowName: "dynamic-body-name",
      }),
    ).rejects.toThrow("WORKFLOW_NOT_FOUND");
  });
});
