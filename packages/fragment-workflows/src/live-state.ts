import type { InstanceStatus, WorkflowStateShape } from "./workflow";

export type WorkflowLiveStateSnapshot<TState extends WorkflowStateShape = WorkflowStateShape> = {
  workflowName: string;
  instanceId: string;
  runNumber: number | null;
  status: InstanceStatus["status"];
  capturedAt: Date;
  state: TState;
};

export type WorkflowLiveStateSnapshotLookup = {
  workflowName?: string;
  runNumber?: number | null;
};

export type WorkflowLiveStateService<TState extends WorkflowStateShape = WorkflowStateShape> = {
  get: (
    instanceId: string,
    options?: WorkflowLiveStateSnapshotLookup,
  ) => WorkflowLiveStateSnapshot<TState> | null;
};

export type WorkflowLiveStateObserver<TState extends WorkflowStateShape = WorkflowStateShape> = {
  set: (snapshot: WorkflowLiveStateSnapshot<TState>) => void;
};

export type WorkflowLiveStateStore<TState extends WorkflowStateShape = WorkflowStateShape> =
  WorkflowLiveStateService<TState> &
    WorkflowLiveStateObserver<TState> & {
      delete: (instanceId: string) => void;
      clear: () => void;
      size: () => number;
    };

const isMatchingSnapshot = <TState extends WorkflowStateShape>(
  snapshot: WorkflowLiveStateSnapshot<TState>,
  options: WorkflowLiveStateSnapshotLookup | undefined,
) => {
  if (options?.workflowName && snapshot.workflowName !== options.workflowName) {
    return false;
  }
  if (options && "runNumber" in options && snapshot.runNumber !== options.runNumber) {
    return false;
  }
  return true;
};

export const createWorkflowLiveStateStore = <
  TState extends WorkflowStateShape = WorkflowStateShape,
>(): WorkflowLiveStateStore<TState> => {
  const snapshots = new Map<string, WorkflowLiveStateSnapshot<TState>>();

  return {
    set(snapshot) {
      snapshots.set(snapshot.instanceId, snapshot);
    },
    get(instanceId, lookup) {
      const snapshot = snapshots.get(instanceId);
      if (!snapshot) {
        return null;
      }
      if (!isMatchingSnapshot(snapshot, lookup)) {
        snapshots.delete(instanceId);
        return null;
      }
      return snapshot;
    },
    delete(instanceId) {
      snapshots.delete(instanceId);
    },
    clear() {
      snapshots.clear();
    },
    size() {
      return snapshots.size;
    },
  };
};
