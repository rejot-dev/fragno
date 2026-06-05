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
import { defineRemoteWorkflow, type WorkflowEvent } from "./workflow";

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
