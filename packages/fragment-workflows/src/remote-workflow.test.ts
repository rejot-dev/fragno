import { describe, expect, test } from "vitest";

import { Worker, threadId } from "node:worker_threads";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type { RemoteWorkflowStepHost } from "./remote-workflow";
import {
  REMOTE_WORKFLOW_MESSAGE_KEY,
  createWorkflowStepMessageTarget,
} from "./remote-workflow-message";
import { defineScenario, runScenario } from "./scenario";
import { createWorkflowsTestHarness } from "./test";
import { defineRemoteWorkflow, defineWorkflow, type WorkflowEvent } from "./workflow";

type WorkerMessage = { type: "result"; result: unknown } | { type: "error"; error: string };

const remoteWorkerSource = (messageKey: string) => String.raw`
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
  workflowServiceCalls: async (factory) => {
    await request("tx.workflowServiceCalls", { txId, operations: factory() });
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
    const topLevel = await step.do("shared", async () => "top-level-value");
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
): Promise<unknown> => {
  const worker = new Worker(remoteWorkerSource(REMOTE_WORKFLOW_MESSAGE_KEY), { eval: true });
  const target = createWorkflowStepMessageTarget(remote, worker);
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
      async (event, remote) => await runWorkflowBodyInWorker(event, remote),
    );

    const workflows = { WORKER_REMOTE: WorkerRemoteWorkflow };

    await runScenario(
      defineScenario({
        name: "worker-remote-workflow",
        workflows,
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
