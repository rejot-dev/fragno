import { instantiate, type InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase, TxResult } from "@fragno-dev/db";

import { workflowsFragmentDefinition } from "./definition";
import type { WorkflowLiveStateSnapshot } from "./live-state";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import type {
  WorkflowEntryFromName,
  WorkflowNameFromRegistry,
  WorkflowRegistryEntry,
  WorkflowRestoredState,
  WorkflowStateFromEntry,
  WorkflowsFragmentConfig,
  WorkflowsRegistry,
} from "./workflow";

const routes = [workflowsRoutesFactory] as const;

type UntypedWorkflowsFragment = InstantiatedFragmentFromDefinition<
  typeof workflowsFragmentDefinition
>;
type UntypedWorkflowsServices = UntypedWorkflowsFragment["services"];

type RestoreInstanceStateReadModel = UntypedWorkflowsServices["restoreInstanceState"] extends (
  ...args: infer _TArgs
) => TxResult<unknown, infer TReadModel>
  ? TReadModel
  : never;

type UntypedRestoreInstanceStateResult = UntypedWorkflowsServices["restoreInstanceState"] extends (
  ...args: infer _TArgs
) => infer TResult
  ? TResult
  : never;

type UntypedGetLiveInstanceStateResult = UntypedWorkflowsServices["getLiveInstanceState"] extends (
  ...args: infer _TArgs
) => infer TResult
  ? TResult
  : never;

type LiveInstanceStateFromEntry<TEntry> =
  WorkflowStateFromEntry<TEntry> extends undefined
    ? null
    : WorkflowLiveStateSnapshot<
        Extract<WorkflowStateFromEntry<TEntry>, Record<string, unknown>>
      > | null;

export type WorkflowsFragmentServices<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> =
  Omit<UntypedWorkflowsServices, "getLiveInstanceState" | "restoreInstanceState"> & {
    restoreInstanceState: {
      <TWorkflowName extends WorkflowNameFromRegistry<TRegistry>>(
        workflowName: TWorkflowName,
        instanceId: string,
      ): TxResult<
        WorkflowRestoredState<WorkflowEntryFromName<TRegistry, TWorkflowName>>,
        RestoreInstanceStateReadModel
      >;
      <TWorkflow extends WorkflowRegistryEntry>(
        workflow: TWorkflow,
        instanceId: string,
      ): TxResult<WorkflowRestoredState<TWorkflow>, RestoreInstanceStateReadModel>;
      (workflowName: string, instanceId: string): UntypedRestoreInstanceStateResult;
    };
    getLiveInstanceState: {
      <TWorkflowName extends WorkflowNameFromRegistry<TRegistry>>(
        workflowName: TWorkflowName,
        instanceId: string,
      ): LiveInstanceStateFromEntry<WorkflowEntryFromName<TRegistry, TWorkflowName>>;
      <TWorkflow extends WorkflowRegistryEntry>(
        workflow: TWorkflow,
        instanceId: string,
      ): LiveInstanceStateFromEntry<TWorkflow>;
      (workflowName: string, instanceId: string): UntypedGetLiveInstanceStateResult;
    };
  };

export type WorkflowsFragment<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> =
  UntypedWorkflowsFragment & {
    readonly services: WorkflowsFragmentServices<TRegistry>;
  };

/** Create a workflows fragment with routes and database integration. */
export function createWorkflowsFragment<TRegistry extends WorkflowsRegistry = WorkflowsRegistry>(
  config: WorkflowsFragmentConfig<TRegistry>,
  fragnoConfig: FragnoPublicConfigWithDatabase,
): WorkflowsFragment<TRegistry> {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();

  return fragment as WorkflowsFragment<TRegistry>;
}

export { workflowsFragmentDefinition };
export { workflowsRoutesFactory };
export { workflowsSchema };
export { restoreWorkflowState } from "./runner/restore-state";
export { createWorkflowLiveStateStore } from "./live-state";
export type { WorkflowsHistory, WorkflowsHistoryEvent, WorkflowsHistoryStep } from "./definition";
export { defineWorkflow } from "./workflow";
export type { WorkflowDefinition } from "./workflow";
export * from "./workflow";
export type {
  WorkflowLiveStateObserver,
  WorkflowLiveStateService,
  WorkflowLiveStateSnapshot,
  WorkflowLiveStateSnapshotLookup,
  WorkflowLiveStateStore,
} from "./live-state";
