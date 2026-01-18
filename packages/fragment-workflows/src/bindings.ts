import type { TxResult } from "@fragno-dev/db";
import type { InstanceStatus, WorkflowBindings, WorkflowsRegistry } from "./workflow";

type WorkflowInstanceOptions = { id?: string; params?: unknown };
type WorkflowInstanceBatchOptions = { id: string; params?: unknown };

export type WorkflowsBindingsAdapter = {
  createInstance: (
    workflowName: string,
    options?: WorkflowInstanceOptions,
  ) => Promise<{ id: string } | { id: string; details: InstanceStatus }>;
  createBatch: (
    workflowName: string,
    instances: WorkflowInstanceBatchOptions[],
  ) => Promise<Array<{ id: string } | { id: string; details: InstanceStatus }>>;
  getInstanceStatus: (workflowName: string, instanceId: string) => Promise<InstanceStatus>;
  pauseInstance: (workflowName: string, instanceId: string) => Promise<InstanceStatus>;
  resumeInstance: (workflowName: string, instanceId: string) => Promise<InstanceStatus>;
  terminateInstance: (workflowName: string, instanceId: string) => Promise<InstanceStatus>;
  restartInstance: (workflowName: string, instanceId: string) => Promise<InstanceStatus>;
  sendEvent: (
    workflowName: string,
    instanceId: string,
    options: { type: string; payload?: unknown },
  ) => Promise<InstanceStatus>;
};

type RunInContext = <T>(callback: () => T | Promise<T>) => T | Promise<T>;

type FragmentWithWorkflowsServices = {
  services: {
    createInstance: (workflowName: string, options?: WorkflowInstanceOptions) => unknown;
    createBatch: (workflowName: string, instances: WorkflowInstanceBatchOptions[]) => unknown;
    getInstanceStatus: (workflowName: string, instanceId: string) => unknown;
    pauseInstance: (workflowName: string, instanceId: string) => unknown;
    resumeInstance: (workflowName: string, instanceId: string) => unknown;
    terminateInstance: (workflowName: string, instanceId: string) => unknown;
    restartInstance: (workflowName: string, instanceId: string) => unknown;
    sendEvent: (
      workflowName: string,
      instanceId: string,
      options: { type: string; payload?: unknown },
    ) => unknown;
  };
  inContext: RunInContext;
};

const runWithContext = async <T>(
  runner: RunInContext | undefined,
  callback: () => T | Promise<T>,
) => {
  const result = runner ? runner(callback) : callback();
  return await result;
};

const createInstanceBinding = (
  workflowName: string,
  instanceId: string,
  adapter: WorkflowsBindingsAdapter,
  runner?: RunInContext,
) => ({
  id: instanceId,
  status: () => runWithContext(runner, () => adapter.getInstanceStatus(workflowName, instanceId)),
  pause: async () => {
    await runWithContext(runner, () => adapter.pauseInstance(workflowName, instanceId));
  },
  resume: async () => {
    await runWithContext(runner, () => adapter.resumeInstance(workflowName, instanceId));
  },
  terminate: async () => {
    await runWithContext(runner, () => adapter.terminateInstance(workflowName, instanceId));
  },
  restart: async () => {
    await runWithContext(runner, () => adapter.restartInstance(workflowName, instanceId));
  },
  sendEvent: async (options: { type: string; payload?: unknown }) => {
    await runWithContext(runner, () =>
      adapter.sendEvent(workflowName, instanceId, {
        type: options.type,
        payload: options.payload,
      }),
    );
  },
});

export function createWorkflowsBindings(
  workflows: WorkflowsRegistry,
  adapter: WorkflowsBindingsAdapter,
  options?: { runInContext?: RunInContext },
): WorkflowBindings {
  const runner = options?.runInContext;
  const bindings: WorkflowBindings = {};

  for (const [bindingKey, entry] of Object.entries(workflows)) {
    const workflowName = entry.name;

    bindings[bindingKey] = {
      create: async (options) => {
        const created = await runWithContext(runner, () =>
          adapter.createInstance(workflowName, options),
        );
        return createInstanceBinding(workflowName, created.id, adapter, runner);
      },
      createBatch: async (batch) => {
        const created = await runWithContext(runner, () =>
          adapter.createBatch(workflowName, batch),
        );
        return created.map((instance) =>
          createInstanceBinding(workflowName, instance.id, adapter, runner),
        );
      },
      get: async (id) => createInstanceBinding(workflowName, id, adapter, runner),
    };
  }

  return bindings;
}

export function attachWorkflowsBindings<T extends FragmentWithWorkflowsServices>(
  fragment: T,
  workflows: WorkflowsRegistry = {},
): T & { workflows: WorkflowBindings } {
  const runService = <TResult>(call: () => unknown) =>
    fragment.inContext(function (this: { handlerTx: () => unknown }) {
      return (
        this.handlerTx() as {
          withServiceCalls: (factory: () => readonly [TxResult<unknown, unknown>]) => {
            transform: (handler: (input: { serviceResult: [TResult] }) => TResult) => {
              execute: () => Promise<TResult>;
            };
          };
        }
      )
        .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
        .transform(({ serviceResult }) => serviceResult[0])
        .execute();
    }) as Promise<TResult>;

  const adapter: WorkflowsBindingsAdapter = {
    createInstance: (workflowName, options) =>
      runService(() => fragment.services.createInstance(workflowName, options)),
    createBatch: (workflowName, instances) =>
      runService(() => fragment.services.createBatch(workflowName, instances)),
    getInstanceStatus: (workflowName, instanceId) =>
      runService(() => fragment.services.getInstanceStatus(workflowName, instanceId)),
    pauseInstance: (workflowName, instanceId) =>
      runService(() => fragment.services.pauseInstance(workflowName, instanceId)),
    resumeInstance: (workflowName, instanceId) =>
      runService(() => fragment.services.resumeInstance(workflowName, instanceId)),
    terminateInstance: (workflowName, instanceId) =>
      runService(() => fragment.services.terminateInstance(workflowName, instanceId)),
    restartInstance: (workflowName, instanceId) =>
      runService(() => fragment.services.restartInstance(workflowName, instanceId)),
    sendEvent: (workflowName, instanceId, options) =>
      runService(() => fragment.services.sendEvent(workflowName, instanceId, options)),
  };

  const bindings = createWorkflowsBindings(workflows, adapter);

  return Object.assign(fragment, { workflows: bindings });
}
