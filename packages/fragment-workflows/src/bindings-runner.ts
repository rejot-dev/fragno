import type { SimpleQueryInterface, TableToColumnValues } from "@fragno-dev/db/query";
import { FragnoId } from "@fragno-dev/db/schema";
import type {
  InstanceStatus,
  WorkflowEnqueuedHookPayload,
  WorkflowsClock,
  WorkflowsRegistry,
} from "./workflow";
import { workflowsSchema } from "./schema";
import type { WorkflowsBindingsAdapter } from "./bindings";
import { createWorkflowsBindings } from "./bindings";

type WorkflowInstanceRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_instance"]
>;
type TypedUnitOfWork = ReturnType<
  ReturnType<SimpleQueryInterface<typeof workflowsSchema>["createUnitOfWork"]>["forSchema"]
>;

const INSTANCE_STATUSES = new Set<InstanceStatus["status"]>([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
]);

const TERMINAL_STATUSES = new Set<InstanceStatus["status"]>(["complete", "terminated", "errored"]);

const PAUSED_STATUSES = new Set<InstanceStatus["status"]>(["paused", "waitingForPause"]);

const generateInstanceId = (nowMs: number) => {
  const timePart = nowMs.toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `inst_${timePart}_${randomPart}`;
};

const buildInstanceStatus = (instance: WorkflowInstanceRecord): InstanceStatus => {
  const status = INSTANCE_STATUSES.has(instance.status as InstanceStatus["status"])
    ? (instance.status as InstanceStatus["status"])
    : "unknown";

  const error =
    instance.errorName || instance.errorMessage
      ? {
          name: instance.errorName ?? "Error",
          message: instance.errorMessage ?? "",
        }
      : undefined;

  return {
    status,
    error,
    output: instance.output ?? undefined,
  };
};

const updateWithCheck = <T extends keyof (typeof workflowsSchema)["tables"]>(
  adapter: TypedUnitOfWork,
  table: T,
  id: TableToColumnValues<(typeof workflowsSchema)["tables"][T]>["id"],
  data: Partial<Omit<TableToColumnValues<(typeof workflowsSchema)["tables"][T]>, "id">>,
) => {
  adapter.update(table, id, (b) => {
    const builder = b.set(data);
    if (id instanceof FragnoId) {
      builder.check();
    }
    return builder;
  });
};

const ensureInstance = async (
  db: SimpleQueryInterface<typeof workflowsSchema>,
  workflowName: string,
  instanceId: string,
) => {
  const instance = await db.findFirst("workflow_instance", (b) =>
    b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
      eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
    ),
  );

  if (!instance) {
    throw new Error("INSTANCE_NOT_FOUND");
  }

  return instance;
};

const triggerEnqueued = async (
  onWorkflowEnqueued: ((payload: WorkflowEnqueuedHookPayload) => Promise<void> | void) | undefined,
  payload: WorkflowEnqueuedHookPayload,
) => {
  await onWorkflowEnqueued?.(payload);
};

const createRunnerBindingsAdapter = (
  db: SimpleQueryInterface<typeof workflowsSchema>,
  onWorkflowEnqueued?: (payload: WorkflowEnqueuedHookPayload) => Promise<void> | void,
  clock?: WorkflowsClock,
): WorkflowsBindingsAdapter => {
  const getNow = () => clock?.now() ?? new Date();

  return {
    createInstance: async (workflowName, options) => {
      const now = getNow();
      const instanceId = options?.id ?? generateInstanceId(now.getTime());
      const params = options?.params ?? {};

      const existing = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
        ),
      );

      if (existing) {
        throw new Error("INSTANCE_ID_ALREADY_EXISTS");
      }

      const uow = db.createUnitOfWork("workflow-create-instance");
      const typed = uow.forSchema(workflowsSchema);
      typed.create("workflow_instance", {
        workflowName,
        instanceId,
        status: "queued",
        params,
        pauseRequested: false,
        retentionUntil: null,
        runNumber: 0,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      typed.create("workflow_task", {
        workflowName,
        instanceId,
        runNumber: 0,
        kind: "run",
        runAt: now,
        status: "pending",
        attempts: 0,
        maxAttempts: 1,
        lastError: null,
        lockedUntil: null,
        lockOwner: null,
      });

      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("INSTANCE_CREATE_FAILED");
      }

      await triggerEnqueued(onWorkflowEnqueued, {
        workflowName,
        instanceId,
        reason: "create",
      });

      return { id: instanceId };
    },
    createBatch: async (workflowName, instances) => {
      if (instances.length === 0) {
        return [];
      }

      const now = getNow();
      const existingInstances = await db.find("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb(
              "instanceId",
              "in",
              instances.map((instance) => instance.id),
            ),
          ),
        ),
      );

      const existingIds = new Set(existingInstances.map((record) => record.instanceId));
      const created: Array<{ id: string }> = [];

      const uow = db.createUnitOfWork("workflow-create-batch");
      const typed = uow.forSchema(workflowsSchema);

      for (const instance of instances) {
        if (existingIds.has(instance.id)) {
          continue;
        }

        typed.create("workflow_instance", {
          workflowName,
          instanceId: instance.id,
          status: "queued",
          params: instance.params ?? {},
          pauseRequested: false,
          retentionUntil: null,
          runNumber: 0,
          startedAt: null,
          completedAt: null,
          output: null,
          errorName: null,
          errorMessage: null,
        });

        typed.create("workflow_task", {
          workflowName,
          instanceId: instance.id,
          runNumber: 0,
          kind: "run",
          runAt: now,
          status: "pending",
          attempts: 0,
          maxAttempts: 1,
          lastError: null,
          lockedUntil: null,
          lockOwner: null,
        });

        created.push({ id: instance.id });
      }

      if (created.length === 0) {
        return [];
      }

      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("INSTANCE_CREATE_FAILED");
      }

      await Promise.all(
        created.map((instance) =>
          triggerEnqueued(onWorkflowEnqueued, {
            workflowName,
            instanceId: instance.id,
            reason: "create",
          }),
        ),
      );

      return created;
    },
    getInstanceStatus: async (workflowName, instanceId) => {
      const instance = await ensureInstance(db, workflowName, instanceId);
      return buildInstanceStatus(instance);
    },
    pauseInstance: async (workflowName, instanceId) => {
      const instance = await ensureInstance(db, workflowName, instanceId);
      const currentStatus = buildInstanceStatus(instance).status;

      if (TERMINAL_STATUSES.has(currentStatus)) {
        throw new Error("INSTANCE_TERMINAL");
      }

      if (currentStatus === "running") {
        const uow = db.createUnitOfWork("workflow-pause");
        const typed = uow.forSchema(workflowsSchema);
        updateWithCheck(typed, "workflow_instance", instance.id, {
          status: "waitingForPause",
          pauseRequested: true,
          updatedAt: getNow(),
        });
        await uow.executeMutations();
        return buildInstanceStatus({
          ...instance,
          status: "waitingForPause",
          pauseRequested: true,
        });
      }

      if (currentStatus === "queued" || currentStatus === "waiting") {
        const uow = db.createUnitOfWork("workflow-pause");
        const typed = uow.forSchema(workflowsSchema);
        updateWithCheck(typed, "workflow_instance", instance.id, {
          status: "paused",
          pauseRequested: false,
          updatedAt: getNow(),
        });
        await uow.executeMutations();
        return buildInstanceStatus({
          ...instance,
          status: "paused",
          pauseRequested: false,
        });
      }

      return buildInstanceStatus(instance);
    },
    resumeInstance: async (workflowName, instanceId) => {
      const now = getNow();
      const instance = await ensureInstance(db, workflowName, instanceId);
      const currentStatus = buildInstanceStatus(instance).status;

      if (currentStatus !== "paused") {
        return buildInstanceStatus(instance);
      }

      const tasks = await db.find("workflow_task", (b) =>
        b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
        ),
      );
      const task = tasks.find((candidate) => candidate.runNumber === instance.runNumber);

      const uow = db.createUnitOfWork("workflow-resume");
      const typed = uow.forSchema(workflowsSchema);
      updateWithCheck(typed, "workflow_instance", instance.id, {
        status: "queued",
        pauseRequested: false,
        updatedAt: now,
      });

      if (task) {
        updateWithCheck(typed, "workflow_task", task.id, {
          kind: "resume",
          runAt: now,
          status: "pending",
          attempts: 0,
          lastError: null,
          lockedUntil: null,
          lockOwner: null,
          updatedAt: now,
        });
      } else {
        typed.create("workflow_task", {
          workflowName,
          instanceId,
          runNumber: instance.runNumber,
          kind: "resume",
          runAt: now,
          status: "pending",
          attempts: 0,
          maxAttempts: 1,
          lastError: null,
          lockedUntil: null,
          lockOwner: null,
        });
      }

      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("INSTANCE_RESUME_FAILED");
      }

      await triggerEnqueued(onWorkflowEnqueued, {
        workflowName,
        instanceId,
        reason: "resume",
      });

      return buildInstanceStatus({
        ...instance,
        status: "queued",
        pauseRequested: false,
      });
    },
    terminateInstance: async (workflowName, instanceId) => {
      const now = getNow();
      const instance = await ensureInstance(db, workflowName, instanceId);
      const currentStatus = buildInstanceStatus(instance).status;

      if (TERMINAL_STATUSES.has(currentStatus)) {
        throw new Error("INSTANCE_TERMINAL");
      }

      const uow = db.createUnitOfWork("workflow-terminate");
      const typed = uow.forSchema(workflowsSchema);
      updateWithCheck(typed, "workflow_instance", instance.id, {
        status: "terminated",
        completedAt: now,
        updatedAt: now,
        pauseRequested: false,
      });
      await uow.executeMutations();

      return buildInstanceStatus({
        ...instance,
        status: "terminated",
        pauseRequested: false,
      });
    },
    restartInstance: async (workflowName, instanceId) => {
      const now = getNow();
      const instance = await ensureInstance(db, workflowName, instanceId);
      const nextRun = instance.runNumber + 1;

      const uow = db.createUnitOfWork("workflow-restart");
      const typed = uow.forSchema(workflowsSchema);
      updateWithCheck(typed, "workflow_instance", instance.id, {
        status: "queued",
        pauseRequested: false,
        runNumber: nextRun,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
        updatedAt: now,
      });
      typed.create("workflow_task", {
        workflowName,
        instanceId,
        runNumber: nextRun,
        kind: "run",
        runAt: now,
        status: "pending",
        attempts: 0,
        maxAttempts: 1,
        lastError: null,
        lockedUntil: null,
        lockOwner: null,
      });

      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("INSTANCE_RESTART_FAILED");
      }

      await triggerEnqueued(onWorkflowEnqueued, {
        workflowName,
        instanceId,
        reason: "create",
      });

      return buildInstanceStatus({
        ...instance,
        status: "queued",
        pauseRequested: false,
        runNumber: nextRun,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
    },
    sendEvent: async (workflowName, instanceId, options) => {
      const now = getNow();
      const instance = await ensureInstance(db, workflowName, instanceId);
      const currentStatus = buildInstanceStatus(instance).status;

      if (TERMINAL_STATUSES.has(currentStatus)) {
        throw new Error("INSTANCE_TERMINAL");
      }

      const steps = await db.find("workflow_step", (b) =>
        b.whereIndex("idx_workflow_step_workflowName_instanceId_status", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb("instanceId", "=", instanceId),
            eb("status", "=", "waiting"),
          ),
        ),
      );
      const tasks = await db.find("workflow_task", (b) =>
        b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
        ),
      );

      const currentRunSteps = steps.filter((step) => step.runNumber === instance.runNumber);
      const currentTask = tasks.find((candidate) => candidate.runNumber === instance.runNumber);
      const shouldWake =
        currentStatus === "waiting" &&
        !PAUSED_STATUSES.has(currentStatus) &&
        currentRunSteps.some((step) => step.waitEventType === options.type);

      const uow = db.createUnitOfWork("workflow-send-event");
      const typed = uow.forSchema(workflowsSchema);
      typed.create("workflow_event", {
        workflowName,
        instanceId,
        runNumber: instance.runNumber,
        type: options.type,
        payload: options.payload ?? null,
        deliveredAt: null,
        consumedByStepKey: null,
      });

      if (shouldWake) {
        if (currentTask) {
          updateWithCheck(typed, "workflow_task", currentTask.id, {
            kind: "wake",
            runAt: now,
            status: "pending",
            attempts: 0,
            lastError: null,
            lockedUntil: null,
            lockOwner: null,
            updatedAt: now,
          });
        } else {
          typed.create("workflow_task", {
            workflowName,
            instanceId,
            runNumber: instance.runNumber,
            kind: "wake",
            runAt: now,
            status: "pending",
            attempts: 0,
            maxAttempts: 1,
            lastError: null,
            lockedUntil: null,
            lockOwner: null,
          });
        }
      }

      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("WORKFLOW_EVENT_FAILED");
      }

      if (shouldWake) {
        await triggerEnqueued(onWorkflowEnqueued, {
          workflowName,
          instanceId,
          reason: "event",
        });
      }

      return buildInstanceStatus(instance);
    },
  };
};

export function createWorkflowsBindingsForRunner(options: {
  db: SimpleQueryInterface<typeof workflowsSchema>;
  workflows: WorkflowsRegistry;
  onWorkflowEnqueued?: (payload: WorkflowEnqueuedHookPayload) => Promise<void> | void;
  clock?: WorkflowsClock;
}) {
  const adapter = createRunnerBindingsAdapter(
    options.db,
    options.onWorkflowEnqueued,
    options.clock,
  );
  return createWorkflowsBindings(options.workflows, adapter);
}
