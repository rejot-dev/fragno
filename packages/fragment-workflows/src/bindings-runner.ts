import type { DatabaseRequestContext, TxResult } from "@fragno-dev/db";
import type { WorkflowsRegistry } from "./workflow";
import type { WorkflowsBindingsAdapter } from "./bindings";
import { createWorkflowsBindings } from "./bindings";

type RunInContext = <T>(
  callback: (this: DatabaseRequestContext) => T | Promise<T>,
) => T | Promise<T>;

type WorkflowsRunnerFragment = {
  inContext: RunInContext;
  services: Record<string, unknown>;
};

type WorkflowsRunnerServices = {
  createInstance: (workflowName: string, options?: { id?: string; params?: unknown }) => unknown;
  createBatch: (workflowName: string, instances: { id: string; params?: unknown }[]) => unknown;
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

const runService = async <TResult>(
  fragment: WorkflowsRunnerFragment,
  call: () => unknown,
): Promise<TResult> =>
  fragment.inContext(function (this: DatabaseRequestContext) {
    return this.handlerTx()
      .withServiceCalls(() => [call() as TxResult<unknown, unknown>])
      .transform(({ serviceResult: [result] }) => result)
      .execute();
  }) as Promise<TResult>;

export function createWorkflowsBindingsForRunner(options: {
  fragment: WorkflowsRunnerFragment;
  workflows: WorkflowsRegistry;
}) {
  const fragment = options.fragment;
  const services = fragment.services as WorkflowsRunnerServices;

  const adapter: WorkflowsBindingsAdapter = {
    createInstance: (workflowName, options) =>
      runService(fragment, () => services.createInstance(workflowName, options)),
    createBatch: (workflowName, instances) =>
      runService(fragment, () => services.createBatch(workflowName, instances)),
    getInstanceStatus: (workflowName, instanceId) =>
      runService(fragment, () => services.getInstanceStatus(workflowName, instanceId)),
    pauseInstance: (workflowName, instanceId) =>
      runService(fragment, () => services.pauseInstance(workflowName, instanceId)),
    resumeInstance: (workflowName, instanceId) =>
      runService(fragment, () => services.resumeInstance(workflowName, instanceId)),
    terminateInstance: (workflowName, instanceId) =>
      runService(fragment, () => services.terminateInstance(workflowName, instanceId)),
    restartInstance: (workflowName, instanceId) =>
      runService(fragment, () => services.restartInstance(workflowName, instanceId)),
    sendEvent: (workflowName, instanceId, options) =>
      runService(fragment, () => services.sendEvent(workflowName, instanceId, options)),
  };

  return createWorkflowsBindings(options.workflows, adapter);
}
