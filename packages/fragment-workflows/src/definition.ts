// Fragment definition and service implementations for workflow instances.
import { defineFragment } from "@fragno-dev/core";
import { dbNow, withDatabase } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db";
import type { FragnoId } from "@fragno-dev/db/schema";
import { workflowsSchema } from "./schema";
import type {
  InstanceStatus,
  WorkflowEnqueuedHookPayload,
  WorkflowInstanceCurrentStep,
  WorkflowInstanceMetadata,
  WorkflowLogLevel,
  WorkflowRegistryEntry,
  WorkflowsFragmentConfig,
} from "./workflow";

const DEFAULT_PAGE_SIZE = 25;

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

type WorkflowInstanceRecord = {
  workflowName: string;
  status: string;
  params: unknown;
  pauseRequested: boolean;
  runNumber: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  output: unknown | null;
  errorName: string | null;
  errorMessage: string | null;
};

type WorkflowInstanceStatusRecord = {
  status: string;
  output: unknown | null;
  errorName: string | null;
  errorMessage: string | null;
};

type WorkflowStepRecord = {
  id: FragnoId;
  runNumber: number;
  stepKey: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number | null;
  nextRetryAt: Date | null;
  wakeAt: Date | null;
  waitEventType: string | null;
  result: unknown | null;
  errorName: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type WorkflowEventRecord = {
  id: FragnoId;
  runNumber: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

type WorkflowLogRecord = {
  id: FragnoId;
  runNumber: number;
  stepKey: string | null;
  attempt: number | null;
  level: WorkflowLogLevel;
  category: string;
  message: string;
  data: unknown | null;
  createdAt: Date;
};

type WorkflowStepHistoryEntry = {
  id: string;
  runNumber: number;
  stepKey: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number | null;
  nextRetryAt: Date | null;
  wakeAt: Date | null;
  waitEventType: string | null;
  result: unknown | null;
  error?: { name: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

type WorkflowEventHistoryEntry = {
  id: string;
  runNumber: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

type WorkflowLogHistoryEntry = {
  id: string;
  runNumber: number;
  stepKey: string | null;
  attempt: number | null;
  level: WorkflowLogLevel;
  category: string;
  message: string;
  data: unknown | null;
  createdAt: Date;
};

type ListInstancesParams = {
  workflowName: string;
  status?: InstanceStatus["status"];
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type ListHistoryParams = {
  workflowName: string;
  instanceId: string;
  runNumber: number;
  pageSize?: number;
  stepsCursor?: Cursor;
  eventsCursor?: Cursor;
  includeLogs?: boolean;
  logsCursor?: Cursor;
  logLevel?: WorkflowLogLevel;
  logCategory?: string;
  order?: "asc" | "desc";
};

type InstanceDetails = { id: string; details: InstanceStatus };

function generateInstanceId(nowMs: number, randomFloat: () => number) {
  const timePart = nowMs.toString(36);
  const randomPart = randomFloat().toString(36).slice(2, 10);
  return `inst_${timePart}_${randomPart}`;
}

function buildInstanceStatus(instance: WorkflowInstanceStatusRecord): InstanceStatus {
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
}

function buildInstanceMetadata(instance: WorkflowInstanceRecord): WorkflowInstanceMetadata {
  return {
    workflowName: instance.workflowName,
    runNumber: instance.runNumber,
    params: instance.params ?? {},
    pauseRequested: instance.pauseRequested,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    startedAt: instance.startedAt,
    completedAt: instance.completedAt,
  };
}

function buildCurrentStepSummary(step: WorkflowStepRecord): WorkflowInstanceCurrentStep {
  const error =
    step.errorName || step.errorMessage
      ? {
          name: step.errorName ?? "Error",
          message: step.errorMessage ?? "",
        }
      : undefined;

  return {
    stepKey: step.stepKey,
    name: step.name,
    type: step.type,
    status: step.status,
    attempts: step.attempts,
    maxAttempts: step.maxAttempts,
    timeoutMs: step.timeoutMs,
    nextRetryAt: step.nextRetryAt,
    wakeAt: step.wakeAt,
    waitEventType: step.waitEventType,
    error,
  };
}

function buildStepHistoryEntry(step: WorkflowStepRecord): WorkflowStepHistoryEntry {
  const error =
    step.errorName || step.errorMessage
      ? {
          name: step.errorName ?? "Error",
          message: step.errorMessage ?? "",
        }
      : undefined;

  return {
    id: step.id.toString(),
    runNumber: step.runNumber,
    stepKey: step.stepKey,
    name: step.name,
    type: step.type,
    status: step.status,
    attempts: step.attempts,
    maxAttempts: step.maxAttempts,
    timeoutMs: step.timeoutMs,
    nextRetryAt: step.nextRetryAt,
    wakeAt: step.wakeAt,
    waitEventType: step.waitEventType,
    result: step.result ?? null,
    error,
    createdAt: step.createdAt,
    updatedAt: step.updatedAt,
  };
}

function buildEventHistoryEntry(event: WorkflowEventRecord): WorkflowEventHistoryEntry {
  return {
    id: event.id.toString(),
    runNumber: event.runNumber,
    type: event.type,
    payload: event.payload ?? null,
    createdAt: event.createdAt,
    deliveredAt: event.deliveredAt,
    consumedByStepKey: event.consumedByStepKey,
  };
}

function buildLogHistoryEntry(log: WorkflowLogRecord): WorkflowLogHistoryEntry {
  return {
    id: log.id.toString(),
    runNumber: log.runNumber,
    stepKey: log.stepKey,
    attempt: log.attempt,
    level: log.level,
    category: log.category,
    message: log.message,
    data: log.data ?? null,
    createdAt: log.createdAt,
  };
}

function isTerminalStatus(status: InstanceStatus["status"]) {
  return TERMINAL_STATUSES.has(status);
}

function isPausedStatus(status: InstanceStatus["status"]) {
  return PAUSED_STATUSES.has(status);
}

export const workflowsFragmentDefinition = defineFragment<WorkflowsFragmentConfig>("workflows")
  .extend(withDatabase(workflowsSchema))
  .provideHooks(({ defineHook, config }) => ({
    onWorkflowEnqueued: defineHook(async function (_payload: WorkflowEnqueuedHookPayload) {
      await config.runner?.tick();
    }),
  }))
  .providesBaseService(({ defineService, config }) => {
    const getNow = () => config.runtime.time.now();
    const getDbNow = async () => getNow();
    const getRunAtNow = () => config.dbNow?.() ?? dbNow();
    const randomFloat = () => config.runtime.random.float();
    const workflowsByName = new Map<string, WorkflowRegistryEntry>();

    for (const entry of Object.values(config.workflows ?? {})) {
      workflowsByName.set(entry.name, entry);
    }

    const validateWorkflowParams = async (workflowName: string, params: unknown) => {
      const entry = workflowsByName.get(workflowName);
      if (!entry) {
        throw new Error("WORKFLOW_NOT_FOUND");
      }

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

    return defineService({
      getDbNow,
      validateWorkflowParams,
      createInstance: function (workflowName: string, options?: { id?: string; params?: unknown }) {
        const now = getNow();
        const instanceId = options?.id ?? generateInstanceId(now.getTime(), randomFloat);
        const params = options?.params ?? {};

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              throw new Error("INSTANCE_ID_ALREADY_EXISTS");
            }

            const instanceRef = uow.create("workflow_instance", {
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

            uow.create("workflow_task", {
              instanceRef,
              workflowName,
              instanceId,
              runNumber: 0,
              kind: "run",
              runAt: getRunAtNow(),
              status: "pending",
              attempts: 0,
              maxAttempts: 1,
              lastError: null,
              lockedUntil: null,
              lockOwner: null,
            });

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              reason: "create",
            });

            return {
              id: instanceId,
              details: buildInstanceStatus({
                status: "queued",
                output: null,
                errorName: null,
                errorMessage: null,
              }),
            };
          })
          .build();
      },
      createBatch: function (workflowName: string, instances: { id: string; params?: unknown }[]) {
        if (instances.length === 0) {
          return Promise.resolve([]);
        }

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.find("workflow_instance", (b) =>
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
            ),
          )
          .mutate(({ uow, retrieveResult: [existingInstances] }) => {
            const existingIds = new Set(existingInstances.map((record) => record.instanceId));
            const processedIds = new Set<string>();

            const created: InstanceDetails[] = [];

            for (const instance of instances) {
              if (existingIds.has(instance.id) || processedIds.has(instance.id)) {
                continue;
              }
              processedIds.add(instance.id);

              const instanceRef = uow.create("workflow_instance", {
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

              uow.create("workflow_task", {
                instanceRef,
                workflowName,
                instanceId: instance.id,
                runNumber: 0,
                kind: "run",
                runAt: getRunAtNow(),
                status: "pending",
                attempts: 0,
                maxAttempts: 1,
                lastError: null,
                lockedUntil: null,
                lockOwner: null,
              });

              uow.triggerHook("onWorkflowEnqueued", {
                workflowName,
                instanceId: instance.id,
                reason: "create",
              });

              created.push({
                id: instance.id,
                details: buildInstanceStatus({
                  status: "queued",
                  output: null,
                  errorName: null,
                  errorMessage: null,
                }),
              });
            }

            return created;
          })
          .build();
      },
      getInstanceStatus: function (workflowName: string, instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .transformRetrieve(([instance]) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }
            return buildInstanceStatus(instance);
          })
          .build();
      },
      getInstanceMetadata: function (workflowName: string, instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .transformRetrieve(([instance]) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }
            return buildInstanceMetadata(instance);
          })
          .build();
      },
      getInstanceCurrentStep: function ({
        workflowName,
        instanceId,
        runNumber,
      }: {
        workflowName: string;
        instanceId: string;
        runNumber: number;
      }) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("workflow_step", (b) => {
              return b
                .whereIndex("idx_workflow_step_history_createdAt", (eb) =>
                  eb.and(
                    eb("workflowName", "=", workflowName),
                    eb("instanceId", "=", instanceId),
                    eb("runNumber", "=", runNumber),
                  ),
                )
                .orderByIndex("idx_workflow_step_history_createdAt", "desc")
                .pageSize(1);
            }),
          )
          .transformRetrieve(([steps]) => {
            const latest = steps.items[0];
            return latest ? buildCurrentStepSummary(latest) : undefined;
          })
          .build();
      },
      getInstanceRunNumber: function (workflowName: string, instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .transformRetrieve(([instance]) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }
            return instance.runNumber;
          })
          .build();
      },
      listInstances: function ({
        workflowName,
        status,
        pageSize = DEFAULT_PAGE_SIZE,
        cursor,
        order = "desc",
      }: ListInstancesParams) {
        const effectivePageSize = cursor?.pageSize ?? pageSize;
        const effectiveOrder = cursor?.orderDirection ?? order;

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("workflow_instance", (b) => {
              if (status) {
                const query = b
                  .whereIndex("idx_workflow_instance_status_updatedAt", (eb) =>
                    eb.and(eb("workflowName", "=", workflowName), eb("status", "=", status)),
                  )
                  .orderByIndex("idx_workflow_instance_status_updatedAt", effectiveOrder)
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }

              const query = b
                .whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb("workflowName", "=", workflowName),
                )
                .orderByIndex("idx_workflow_instance_workflowName_instanceId", effectiveOrder)
                .pageSize(effectivePageSize);

              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(([instances]) => {
            return {
              instances: instances.items.map((instance) => ({
                id: instance.instanceId,
                details: buildInstanceStatus(instance),
                createdAt: instance.createdAt,
              })),
              cursor: instances.cursor,
              hasNextPage: instances.hasNextPage,
            };
          })
          .build();
      },
      listHistory: function ({
        workflowName,
        instanceId,
        runNumber,
        pageSize = DEFAULT_PAGE_SIZE,
        stepsCursor,
        eventsCursor,
        includeLogs,
        logsCursor,
        logLevel,
        logCategory,
        order = "desc",
      }: ListHistoryParams) {
        const stepsOrder = stepsCursor?.orderDirection ?? order;
        const eventsOrder = eventsCursor?.orderDirection ?? order;
        const logsOrder = logsCursor?.orderDirection ?? order;
        const stepsPageSize = stepsCursor?.pageSize ?? pageSize;
        const eventsPageSize = eventsCursor?.pageSize ?? pageSize;
        const logsPageSize = logsCursor?.pageSize ?? pageSize;

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) => {
            let chain = uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .findWithCursor("workflow_step", (b) => {
                const query = b
                  .whereIndex("idx_workflow_step_history_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                      eb("runNumber", "=", runNumber),
                    ),
                  )
                  .orderByIndex("idx_workflow_step_history_createdAt", stepsOrder)
                  .pageSize(stepsPageSize);

                return stepsCursor ? query.after(stepsCursor) : query;
              })
              .findWithCursor("workflow_event", (b) => {
                const query = b
                  .whereIndex("idx_workflow_event_history_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                      eb("runNumber", "=", runNumber),
                    ),
                  )
                  .orderByIndex("idx_workflow_event_history_createdAt", eventsOrder)
                  .pageSize(eventsPageSize);

                return eventsCursor ? query.after(eventsCursor) : query;
              });

            const effectiveLogLevel = includeLogs ? logLevel : undefined;
            const effectiveLogCategory = includeLogs ? logCategory : undefined;
            const effectiveLogsCursor = includeLogs ? logsCursor : undefined;
            const effectiveLogsPageSize = includeLogs ? logsPageSize : 1;

            return chain.findWithCursor("workflow_log", (b) => {
              if (effectiveLogLevel) {
                const query = b
                  .whereIndex("idx_workflow_log_level_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                      eb("runNumber", "=", runNumber),
                      eb("level", "=", effectiveLogLevel),
                    ),
                  )
                  .orderByIndex("idx_workflow_log_level_createdAt", logsOrder)
                  .pageSize(effectiveLogsPageSize);

                return effectiveLogsCursor ? query.after(effectiveLogsCursor) : query;
              }

              if (effectiveLogCategory) {
                const query = b
                  .whereIndex("idx_workflow_log_category_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                      eb("runNumber", "=", runNumber),
                      eb("category", "=", effectiveLogCategory),
                    ),
                  )
                  .orderByIndex("idx_workflow_log_category_createdAt", logsOrder)
                  .pageSize(effectiveLogsPageSize);

                return effectiveLogsCursor ? query.after(effectiveLogsCursor) : query;
              }

              const query = b
                .whereIndex("idx_workflow_log_history_createdAt", (eb) =>
                  eb.and(
                    eb("workflowName", "=", workflowName),
                    eb("instanceId", "=", instanceId),
                    eb("runNumber", "=", runNumber),
                  ),
                )
                .orderByIndex("idx_workflow_log_history_createdAt", logsOrder)
                .pageSize(effectiveLogsPageSize);

              return effectiveLogsCursor ? query.after(effectiveLogsCursor) : query;
            });
          })
          .mutate(({ retrieveResult }) => {
            const [instance, steps, events, logs] = retrieveResult as [
              WorkflowInstanceRecord | undefined,
              { items: WorkflowStepRecord[]; cursor?: Cursor; hasNextPage: boolean },
              { items: WorkflowEventRecord[]; cursor?: Cursor; hasNextPage: boolean },
              { items: WorkflowLogRecord[]; cursor?: Cursor; hasNextPage: boolean },
            ];
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const filteredLogs =
              includeLogs && logLevel && logCategory
                ? logs?.items.filter((log) => log.category === logCategory)
                : logs?.items;

            return {
              runNumber,
              steps: steps.items.map(buildStepHistoryEntry),
              events: events.items.map(buildEventHistoryEntry),
              stepsCursor: steps.cursor,
              stepsHasNextPage: steps.hasNextPage,
              eventsCursor: events.cursor,
              eventsHasNextPage: events.hasNextPage,
              logs: includeLogs ? (filteredLogs?.map(buildLogHistoryEntry) ?? []) : undefined,
              logsCursor: includeLogs ? logs.cursor : undefined,
              logsHasNextPage: includeLogs ? logs.hasNextPage : undefined,
            };
          })
          .build();
      },
      pauseInstance: function (workflowName: string, instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [instance] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

            if (currentStatus === "running") {
              uow.update("workflow_instance", instance.id, (b) =>
                b
                  .set({
                    status: "waitingForPause",
                    pauseRequested: true,
                    updatedAt: getNow(),
                  })
                  .check(),
              );

              return buildInstanceStatus({
                status: "waitingForPause",
                output: instance.output,
                errorName: instance.errorName,
                errorMessage: instance.errorMessage,
              });
            }

            if (currentStatus === "queued" || currentStatus === "waiting") {
              uow.update("workflow_instance", instance.id, (b) =>
                b
                  .set({
                    status: "paused",
                    pauseRequested: false,
                    updatedAt: getNow(),
                  })
                  .check(),
              );

              return buildInstanceStatus({
                status: "paused",
                output: instance.output,
                errorName: instance.errorName,
                errorMessage: instance.errorMessage,
              });
            }

            return buildInstanceStatus(instance);
          })
          .build();
      },
      resumeInstance: function (workflowName: string, instanceId: string) {
        const now = getNow();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_task", (b) =>
                b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, tasks] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (currentStatus !== "paused") {
              return buildInstanceStatus(instance);
            }

            const task = tasks.find((candidate) => candidate.runNumber === instance.runNumber);

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "queued",
                  pauseRequested: false,
                  updatedAt: now,
                })
                .check(),
            );

            if (task) {
              uow.update("workflow_task", task.id, (b) =>
                b
                  .set({
                    kind: "resume",
                    runAt: getRunAtNow(),
                    status: "pending",
                    attempts: 0,
                    lastError: null,
                    lockedUntil: null,
                    lockOwner: null,
                    updatedAt: now,
                  })
                  .check(),
              );
            } else {
              uow.create("workflow_task", {
                instanceRef: instance.id,
                workflowName,
                instanceId,
                runNumber: instance.runNumber,
                kind: "resume",
                runAt: getRunAtNow(),
                status: "pending",
                attempts: 0,
                maxAttempts: 1,
                lastError: null,
                lockedUntil: null,
                lockOwner: null,
              });
            }

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              reason: "resume",
            });

            return buildInstanceStatus({
              status: "queued",
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      terminateInstance: function (workflowName: string, instanceId: string) {
        const now = getNow();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [instance] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "terminated",
                  completedAt: now,
                  updatedAt: now,
                  pauseRequested: false,
                })
                .check(),
            );

            return buildInstanceStatus({
              status: "terminated",
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      restartInstance: function (workflowName: string, instanceId: string) {
        const now = getNow();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [instance] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const nextRun = instance.runNumber + 1;

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "queued",
                  pauseRequested: false,
                  runNumber: nextRun,
                  startedAt: null,
                  completedAt: null,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                  updatedAt: now,
                })
                .check(),
            );

            uow.create("workflow_task", {
              instanceRef: instance.id,
              workflowName,
              instanceId,
              runNumber: nextRun,
              kind: "run",
              runAt: getRunAtNow(),
              status: "pending",
              attempts: 0,
              maxAttempts: 1,
              lastError: null,
              lockedUntil: null,
              lockOwner: null,
            });

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              reason: "create",
            });

            return buildInstanceStatus({
              status: "queued",
              output: null,
              errorName: null,
              errorMessage: null,
            });
          })
          .build();
      },
      sendEvent: function (
        workflowName: string,
        instanceId: string,
        options: { type: string; payload?: unknown },
      ) {
        const now = getNow();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_status_wakeAt", (eb) =>
                  eb.and(
                    eb("workflowName", "=", workflowName),
                    eb("instanceId", "=", instanceId),
                    eb("status", "=", "waiting"),
                    eb.or(eb.isNull("wakeAt"), eb("wakeAt", ">", dbNow())),
                  ),
                ),
              )
              .find("workflow_task", (b) =>
                b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, steps, tasks] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

            uow.create("workflow_event", {
              instanceRef: instance.id,
              workflowName,
              instanceId,
              runNumber: instance.runNumber,
              type: options.type,
              payload: options.payload ?? null,
              deliveredAt: null,
              consumedByStepKey: null,
            });

            const currentRunSteps = steps.filter((step) => step.runNumber === instance.runNumber);
            const currentTask = tasks.find(
              (candidate) => candidate.runNumber === instance.runNumber,
            );
            const shouldWake =
              currentStatus === "waiting" &&
              !isPausedStatus(currentStatus) &&
              currentRunSteps.some((step) => step.waitEventType === options.type);

            if (shouldWake) {
              if (currentTask) {
                uow.update("workflow_task", currentTask.id, (b) =>
                  b
                    .set({
                      kind: "wake",
                      runAt: getRunAtNow(),
                      status: "pending",
                      attempts: 0,
                      lastError: null,
                      lockedUntil: null,
                      lockOwner: null,
                      updatedAt: now,
                    })
                    .check(),
                );
              } else {
                uow.create("workflow_task", {
                  instanceRef: instance.id,
                  workflowName,
                  instanceId,
                  runNumber: instance.runNumber,
                  kind: "wake",
                  runAt: getRunAtNow(),
                  status: "pending",
                  attempts: 0,
                  maxAttempts: 1,
                  lastError: null,
                  lockedUntil: null,
                  lockOwner: null,
                });
              }

              uow.triggerHook("onWorkflowEnqueued", {
                workflowName,
                instanceId,
                reason: "event",
              });
            }

            return buildInstanceStatus(instance);
          })
          .build();
      },
    });
  })
  .build();
