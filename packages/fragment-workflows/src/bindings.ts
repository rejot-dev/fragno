import type { TxResult } from "@fragno-dev/db";
import type {
  InstanceStatus,
  InstanceStatusWithOutput,
  WorkflowBindings,
  WorkflowInstance,
  WorkflowOutputFromEntry,
  WorkflowParamsFromEntry,
  WorkflowRegistryEntry,
  WorkflowsRegistry,
} from "./workflow";

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

const validateWorkflowParams = async (entry: WorkflowRegistryEntry, params: unknown) => {
  if ("workflow" in entry) {
    return params ?? {};
  }

  if (!entry.schema) {
    return params ?? {};
  }

  const result = await entry.schema["~standard"].validate(params ?? {});
  if (result.issues) {
    const error = new Error("WORKFLOW_PARAMS_INVALID");
    (error as { issues?: unknown }).issues = result.issues;
    throw error;
  }

  return result.value;
};

const createInstanceBinding = <TOutput>(
  workflowName: string,
  instanceId: string,
  adapter: WorkflowsBindingsAdapter,
  runner?: RunInContext,
): WorkflowInstance<TOutput> => ({
  id: instanceId,
  status: async () =>
    (await runWithContext(runner, () =>
      adapter.getInstanceStatus(workflowName, instanceId),
    )) as InstanceStatusWithOutput<TOutput>,
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

export function createWorkflowsBindings<TRegistry extends WorkflowsRegistry>(
  workflows: TRegistry,
  adapter: WorkflowsBindingsAdapter,
  options?: { runInContext?: RunInContext },
): WorkflowBindings<TRegistry> {
  const runner = options?.runInContext;
  const bindings = {} as WorkflowBindings<TRegistry>;

  for (const bindingKey of Object.keys(workflows) as Array<keyof TRegistry>) {
    const entry = workflows[bindingKey];
    const workflowName = entry.name;
    type TParams = WorkflowParamsFromEntry<typeof entry>;
    type TOutput = WorkflowOutputFromEntry<typeof entry>;

    bindings[bindingKey] = {
      create: async (options) => {
        const params = await validateWorkflowParams(entry, options?.params);
        const created = await runWithContext(runner, () =>
          adapter.createInstance(workflowName, { id: options?.id, params }),
        );
        return createInstanceBinding<TOutput>(workflowName, created.id, adapter, runner);
      },
      createBatch: async (batch) => {
        const validatedBatch = await Promise.all(
          batch.map(async (instance) => ({
            id: instance.id,
            params: await validateWorkflowParams(entry, instance.params),
          })),
        );
        const created = await runWithContext(runner, () =>
          adapter.createBatch(workflowName, validatedBatch),
        );
        return created.map((instance) =>
          createInstanceBinding<TOutput>(workflowName, instance.id, adapter, runner),
        );
      },
      get: async (id) => createInstanceBinding<TOutput>(workflowName, id, adapter, runner),
    } as WorkflowBindings<TRegistry>[typeof bindingKey] & {
      create: (options?: { id?: string; params?: TParams }) => Promise<WorkflowInstance<TOutput>>;
    };
  }

  return bindings;
}

export function attachWorkflowsBindings<
  T extends FragmentWithWorkflowsServices,
  TRegistry extends WorkflowsRegistry,
>(
  fragment: T,
  workflows: TRegistry = {} as TRegistry,
): T & { workflows: WorkflowBindings<TRegistry> } {
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
