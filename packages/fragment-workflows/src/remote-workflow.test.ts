import { assert, describe, expect, expectTypeOf, test } from "vitest";

import { Worker, threadId } from "node:worker_threads";

import { schema } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { getDurableHooksService, withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type { RemoteWorkflowAllowedHook, RemoteWorkflowStepHost } from "./remote-workflow";
import {
  REMOTE_WORKFLOW_MESSAGE_KEY,
  createWorkflowStepMessageTarget,
} from "./remote-workflow-message";
import { defineScenario, runScenario } from "./scenario";
import { createWorkflowsTestHarness } from "./test";
import {
  NonRetryableError,
  defineRemoteWorkflow,
  defineWorkflow,
  type WorkflowEvent,
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

type WorkerMessage = { type: "result"; result: unknown } | { type: "error"; error: string };

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

const remoteWorkerSource = (messageKey: string, target: string) => String.raw`
const { parentPort, threadId } = require("node:worker_threads");

const REMOTE_WORKFLOW_MESSAGE_KEY = ${JSON.stringify(messageKey)};
let nextId = 1;
let currentScope = null;
const pendingRequests = new Map();
const stepCallbacks = new Map();

const request = (method, payload) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pendingRequests.set(id, { resolve, reject });
    parentPort.postMessage({
      [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
      type: "request",
      id,
      method,
      payload,
    });
  });

const createTxProxy = (txId) => ({
  emit: async (payload) => {
    await request("tx.emit", { txId, payload });
  },
  previousEmissions: async () => await request("tx.previousEmissions", { txId }),
  previousConsumedEvents: async () => await request("tx.previousConsumedEvents", { txId }),
  workflowServiceCalls: async (factory) => {
    await request("tx.workflowServiceCalls", { txId, operations: factory() });
  },
  triggerHook: async (operation) => {
    await request("tx.triggerHook", { txId, operation });
  },
  mutate: () => {
    throw new Error("REMOTE_WORKFLOW_TX_MUTATE_UNSUPPORTED");
  },
  serviceCalls: () => {
    throw new Error("REMOTE_WORKFLOW_TX_SERVICE_CALLS_UNSUPPORTED");
  },
  onTerminalError: {
    mutate: () => {
      throw new Error("REMOTE_WORKFLOW_TX_ON_TERMINAL_ERROR_MUTATE_UNSUPPORTED");
    },
  },
});

const step = {
  do: async (name, callback) => {
    const id = nextId++;
    stepCallbacks.set(id, callback);
    try {
      return await new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        parentPort.postMessage({
          [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
          type: "request",
          id,
          method: "do",
          payload: { parentScope: currentScope, name },
        });
      });
    } finally {
      stepCallbacks.delete(id);
    }
  },
};

parentPort.on("message", async (message) => {
  if (!message || message[REMOTE_WORKFLOW_MESSAGE_KEY] !== true) {
    return;
  }

  if (message.type === "response") {
    const handler = pendingRequests.get(message.id);
    if (!handler) {
      return;
    }
    pendingRequests.delete(message.id);
    if (message.error) {
      handler.reject(new Error(message.error.message));
    } else {
      handler.resolve(message.result);
    }
    return;
  }

  if (message.type !== "callback") {
    return;
  }

  const callback = stepCallbacks.get(message.requestId);
  if (!callback) {
    parentPort.postMessage({
      [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
      type: "response",
      id: message.id,
      error: { message: "REMOTE_WORKFLOW_CALLBACK_NOT_FOUND" },
    });
    return;
  }

  const previousScope = currentScope;
  currentScope = message.scope;
  try {
    const result = await callback(createTxProxy(message.txId));
    parentPort.postMessage({
      [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
      type: "response",
      id: message.id,
      result,
    });
  } catch (error) {
    parentPort.postMessage({
      [REMOTE_WORKFLOW_MESSAGE_KEY]: true,
      type: "response",
      id: message.id,
      error: {
        message: error && typeof error === "object" && "message" in error ? error.message : String(error),
      },
    });
  } finally {
    currentScope = previousScope;
  }
});

(async () => {
  try {
    const nested = await step.do("outer", async () => await step.do("shared", async () => "nested-value"));
    const topLevel = await step.do("shared", async (tx) => {
      await tx.triggerHook({
        target: ${JSON.stringify(target)},
        schemaName: ${JSON.stringify(remoteHookTestSchema.name)},
        hookName: "onRemoteStepRecorded",
        payload: { step: "shared" },
        when: "both",
      });
      return "top-level-value";
    });
    parentPort.postMessage({ type: "result", result: { nested, topLevel, threadId } });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      error: error && typeof error === "object" && "message" in error ? error.message : String(error),
    });
  }
})();
`;

const runWorkflowBodyInWorker = async (
  _event: WorkflowEvent<unknown>,
  remote: RemoteWorkflowStepHost,
  allowedHooks: readonly RemoteWorkflowAllowedHook[],
  targetName: string,
): Promise<unknown> => {
  const worker = new Worker(remoteWorkerSource(REMOTE_WORKFLOW_MESSAGE_KEY, targetName), {
    eval: true,
  });
  const target = createWorkflowStepMessageTarget(remote, worker, allowedHooks);
  const detachTarget = target.attach();

  return await new Promise((resolve, reject) => {
    const cleanup = async () => {
      detachTarget();
      await worker.terminate();
    };

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "result") {
        resolve(message.result);
        void cleanup();
        return;
      }
      if (message.type === "error") {
        reject(new Error(message.error));
        void cleanup();
      }
    });
    worker.on("error", (error) => {
      reject(error);
      void cleanup();
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`REMOTE_WORKER_EXITED:${code}`));
      }
    });
  });
};

describe("remote workflow step host", () => {
  test("preserves nested step identity with explicit parent scopes", async () => {
    const RemoteScopeWorkflow = defineRemoteWorkflow(
      { name: "remote-scope-workflow" },
      async (_event, host) => {
        const nested = await host.do(null, "outer", undefined, async (_tx, outerScope) => {
          return await host.do(outerScope, "shared", undefined, async () => "nested-value");
        });
        const topLevel = await host.do(null, "shared", undefined, async () => "top-level-value");

        return { nested, topLevel };
      },
    );

    const workflows = { REMOTE_SCOPE: RemoteScopeWorkflow };

    await runScenario(
      defineScenario({
        name: "remote-scope-workflow",
        workflows,
        steps: ({ runner, workflow }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "REMOTE_SCOPE",
            id: "remote-scope-1",
            remoteWorkflowName: "remote-scope-body",
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("REMOTE_SCOPE", "remote-scope-1"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { nested: "nested-value", topLevel: "top-level-value" },
              });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("REMOTE_SCOPE", "remote-scope-1"),
            assert: (steps) => {
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:outer",
                "do:outer>do:shared",
                "do:shared",
              ]);
              expect(steps.find((step) => step.stepKey === "do:outer>do:shared")).toMatchObject({
                parentStepKey: "do:outer",
                depth: 1,
              });
            },
          }),
        ],
      }),
    );
  });

  test("remote hook intents follow successful and terminal step outcomes", async () => {
    const HookWorkflow = defineRemoteWorkflow<"remote-hook-outcomes", { fail: boolean }>(
      { name: "remote-hook-outcomes" },
      async (event, host) => {
        await host.do(null, "record hook", undefined, async (tx) => {
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
      },
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
      async (_event, host) => {
        await host.do(null, "retry", { retries: { limit: 1, delay: "1 hour" } }, async (tx) => {
          tx.triggerHook({
            namespace: "remote_hook_test",
            hookName: "onRemoteRetryOutcome",
            payload: { result: "terminal" },
            when: "both",
          });
          throw new Error("RETRY_LATER");
        });
      },
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
      async (_event, host) => {
        await host.do(null, "create-child", undefined, async (tx) => {
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
      },
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
    >({ name: "remote-event-child-workflow" }, async (event, host) => {
      await host.do(null, "complete child", undefined, async (tx) => {
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
    });
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

  test("supports Promise.all, Promise.race, Promise.any, and Promise.allSettled in remote steps", async () => {
    const RemotePromiseWorkflow = defineRemoteWorkflow(
      { name: "remote-promise-combinators" },
      async (_event, host) => {
        const all = await Promise.all([
          host.do(null, "all alpha", undefined, async () => "A"),
          host.do(null, "all beta", undefined, async () => "B"),
        ]);

        const raceReturn = await host.do(null, "Promise race", undefined, async (_tx, scope) => {
          return await Promise.race([
            host.do(scope, "race slow", undefined, async (_tx, slowScope) => {
              await host.sleep(slowScope, "race slow delay", 1000);
              return "slow";
            }),
            host.do(scope, "race fast", undefined, async () => "fast"),
          ]);
        });

        const anyReturn = await host.do(null, "Promise any", undefined, async (_tx, scope) => {
          return await Promise.any([
            host.do(scope, "any slow", undefined, async (_tx, slowScope) => {
              await host.sleep(slowScope, "any slow delay", 1000);
              return "slow";
            }),
            host.do(scope, "any fast", undefined, async () => "fast"),
          ]);
        });

        const settled = await host.do(null, "Promise allSettled", undefined, async (_tx, scope) => {
          const results = await Promise.allSettled([
            host.do(scope, "settled ok", undefined, async () => "ok"),
            host.do(scope, "settled fail", undefined, async () => {
              throw new Error("EXPECTED_SETTLED_FAILURE");
            }),
          ]);
          return results.map((result) =>
            result.status === "fulfilled"
              ? { status: result.status, value: result.value }
              : {
                  status: result.status,
                  reason:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                },
          );
        });

        return { all, raceReturn, anyReturn, settled };
      },
    );

    const workflows = { REMOTE_PROMISES: RemotePromiseWorkflow };
    const harness = await createWorkflowsTestHarness({
      workflows,
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("REMOTE_PROMISES", {
      id: "remote-promises-1",
      remoteWorkflowName: "remote-promises-body",
    });
    await harness.runUntilIdle({
      workflowName: "remote-promise-combinators",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("REMOTE_PROMISES", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: {
        all: ["A", "B"],
        raceReturn: "fast",
        anyReturn: "fast",
        settled: [
          { status: "fulfilled", value: "ok" },
          { status: "rejected", reason: "EXPECTED_SETTLED_FAILURE" },
        ],
      },
    });

    const history = await harness.getHistory("REMOTE_PROMISES", instanceId);
    expect(history.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepKey: "do:all alpha", status: "completed", result: "A" }),
        expect.objectContaining({ stepKey: "do:all beta", status: "completed", result: "B" }),
        expect.objectContaining({
          stepKey: "do:Promise race",
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race>do:race slow",
          parentStepKey: "do:Promise race",
          depth: 1,
          status: "waiting",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race>do:race slow>sleep:race slow delay",
          parentStepKey: "do:Promise race>do:race slow",
          depth: 2,
          status: "waiting",
        }),
        expect.objectContaining({
          stepKey: "do:Promise race>do:race fast",
          parentStepKey: "do:Promise race",
          depth: 1,
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({ stepKey: "do:Promise any", status: "completed", result: "fast" }),
        expect.objectContaining({
          stepKey: "do:Promise any>do:any slow",
          parentStepKey: "do:Promise any",
          depth: 1,
          status: "waiting",
        }),
        expect.objectContaining({
          stepKey: "do:Promise any>do:any fast",
          parentStepKey: "do:Promise any",
          depth: 1,
          status: "completed",
          result: "fast",
        }),
        expect.objectContaining({ stepKey: "do:Promise allSettled", status: "completed" }),
        expect.objectContaining({
          stepKey: "do:Promise allSettled>do:settled ok",
          status: "completed",
          result: "ok",
        }),
        expect.objectContaining({
          stepKey: "do:Promise allSettled>do:settled fail",
          status: "errored",
          error: { message: "EXPECTED_SETTLED_FAILURE", name: "Error" },
        }),
      ]),
    );
  });

  test("runs workflow body in a Worker while host owns durable steps", async () => {
    const WorkerRemoteWorkflow = defineRemoteWorkflow(
      { name: "worker-remote-workflow" },
      async (event, remote) =>
        await runWorkflowBodyInWorker(
          event,
          remote,
          [
            {
              target: "tenant",
              schemaName: remoteHookTestSchema.name,
              hookName: "onRemoteStepRecorded",
              namespace: "remote_hook_test",
            },
          ],
          "tenant",
        ),
    );

    const workflows = { WORKER_REMOTE: WorkerRemoteWorkflow };

    await runScenario(
      defineScenario({
        name: "worker-remote-workflow",
        workflows,
        harness: {
          configureBuilder: (builder) =>
            builder.withFragment("remoteHooks", instantiate(remoteHookTestFragment)),
        },
        steps: ({ runner, workflow }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "WORKER_REMOTE",
            id: "worker-remote-1",
            remoteWorkflowName: "worker-thread-body",
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("WORKER_REMOTE", "worker-remote-1"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: {
                  nested: "nested-value",
                  topLevel: "top-level-value",
                },
              });
              expect((status.output as { threadId: number }).threadId).not.toBe(threadId);
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("WORKER_REMOTE", "worker-remote-1"),
            assert: (steps) => {
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:outer",
                "do:outer>do:shared",
                "do:shared",
              ]);
            },
          }),
          workflow.read({
            read: (ctx) =>
              ctx.state.internal.getHooks({
                namespace: "remote_hook_test",
                hookName: "onRemoteStepRecorded",
              }),
            assert: (hooks) => {
              expect(hooks).toEqual([expect.objectContaining({ payload: { step: "shared" } })]);
            },
          }),
        ],
      }),
    );
  });

  test("rejects unlisted hooks from the remote Worker before committing a step", async () => {
    const DeniedWorkflow = defineRemoteWorkflow(
      { name: "worker-remote-hook-denied" },
      async (event, remote) =>
        await runWorkflowBodyInWorker(
          event,
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
      async (event, remote) =>
        await runWorkflowBodyInWorker(event, remote, tenantAHooks, "tenant-a"),
    );
    const TenantBWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-tenant-b" },
      async (event, remote) =>
        await runWorkflowBodyInWorker(event, remote, tenantBHooks, "tenant-b"),
    );
    const CrossTenantWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-cross-tenant" },
      async (event, remote) =>
        await runWorkflowBodyInWorker(event, remote, tenantAHooks, "tenant-b"),
    );
    const AmbiguousTargetWorkflow = defineRemoteWorkflow(
      { name: "remote-hook-ambiguous-target" },
      async (event, remote) =>
        await runWorkflowBodyInWorker(
          event,
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
