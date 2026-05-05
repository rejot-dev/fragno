export type WorkflowStepLiveStateShape = Record<string, unknown>;

export type WorkflowStepLiveStateSnapshot<
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
> = {
  workflowName: string;
  instanceId: string;
  runNumber: number;
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
  name: string;
  capturedAt: Date;
  state: TState;
};

export type WorkflowLiveStateSnapshot<
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
> = WorkflowStepLiveStateSnapshot<TState>;

export type WorkflowLiveStateSnapshotLookup = {
  workflowName?: string;
  runNumber?: number;
  stepKey?: string;
};

export type WorkflowLiveStateLease<
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
> = {
  set: (snapshot: WorkflowStepLiveStateSnapshot<TState>) => void;
  clear: () => void;
};

export type WorkflowLiveStateService<
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
> = {
  get: (
    instanceId: string,
    options?: WorkflowLiveStateSnapshotLookup,
  ) => WorkflowStepLiveStateSnapshot<TState> | null;
  getAll: (
    instanceId: string,
    options?: Omit<WorkflowLiveStateSnapshotLookup, "stepKey">,
  ) => WorkflowStepLiveStateSnapshot<TState>[];
};

export type WorkflowLiveStateObserver<
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
> = {
  set: (snapshot: WorkflowStepLiveStateSnapshot<TState>) => void;
  begin: (snapshot: WorkflowStepLiveStateSnapshot<TState>) => WorkflowLiveStateLease<TState>;
};

export type WorkflowLiveStateStore<
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
> = WorkflowLiveStateService<TState> &
  WorkflowLiveStateObserver<TState> & {
    delete: (instanceId: string, options?: WorkflowLiveStateSnapshotLookup) => void;
    clear: () => void;
    size: () => number;
  };

const snapshotKey = (
  snapshot: Pick<WorkflowStepLiveStateSnapshot, "instanceId" | "runNumber" | "stepKey">,
) => `${snapshot.instanceId}\u0000${snapshot.runNumber}\u0000${snapshot.stepKey}`;

const isMatchingSnapshot = <TState extends WorkflowStepLiveStateShape>(
  snapshot: WorkflowStepLiveStateSnapshot<TState>,
  options: WorkflowLiveStateSnapshotLookup | undefined,
) => {
  if (options?.workflowName && snapshot.workflowName !== options.workflowName) {
    return false;
  }
  if (options && "runNumber" in options && snapshot.runNumber !== options.runNumber) {
    return false;
  }
  if (options?.stepKey && snapshot.stepKey !== options.stepKey) {
    return false;
  }
  return true;
};

export const createWorkflowLiveStateStore = <
  TState extends WorkflowStepLiveStateShape = WorkflowStepLiveStateShape,
>(): WorkflowLiveStateStore<TState> => {
  const snapshots = new Map<string, WorkflowStepLiveStateSnapshot<TState>>();
  const tokens = new Map<string, symbol>();

  const setWithToken = (snapshot: WorkflowStepLiveStateSnapshot<TState>, token?: symbol) => {
    const key = snapshotKey(snapshot);
    snapshots.set(key, snapshot);
    if (token) {
      tokens.set(key, token);
    } else {
      tokens.delete(key);
    }
  };

  return {
    set(snapshot) {
      setWithToken(snapshot);
    },
    begin(snapshot) {
      const token = Symbol("workflow-live-state-lease");
      const key = snapshotKey(snapshot);
      setWithToken(snapshot, token);
      return {
        set(nextSnapshot) {
          if (tokens.get(key) === token) {
            setWithToken(nextSnapshot, token);
          }
        },
        clear() {
          if (tokens.get(key) === token) {
            snapshots.delete(key);
            tokens.delete(key);
          }
        },
      };
    },
    get(instanceId, lookup) {
      for (const snapshot of snapshots.values()) {
        if (snapshot.instanceId === instanceId && isMatchingSnapshot(snapshot, lookup)) {
          return snapshot;
        }
      }
      return null;
    },
    getAll(instanceId, lookup) {
      return [...snapshots.values()].filter(
        (snapshot) => snapshot.instanceId === instanceId && isMatchingSnapshot(snapshot, lookup),
      );
    },
    delete(instanceId, lookup) {
      for (const [key, snapshot] of snapshots) {
        if (snapshot.instanceId === instanceId && isMatchingSnapshot(snapshot, lookup)) {
          snapshots.delete(key);
          tokens.delete(key);
        }
      }
    },
    clear() {
      snapshots.clear();
      tokens.clear();
    },
    size() {
      return snapshots.size;
    },
  };
};
