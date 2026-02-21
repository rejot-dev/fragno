// Fragment definition and service implementations for workflow instances.
import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db";
import type { FragnoId } from "@fragno-dev/db/schema";
import { workflowsSchema } from "./schema";
import type {
  InstanceStatus,
  WorkflowEnqueuedHookPayload,
  WorkflowInstanceCurrentStep,
  WorkflowInstanceMetadata,
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
};

type InstanceDetails = { id: string; details: InstanceStatus };

function generateInstanceId(randomUuid: () => string) {
  return `inst_${randomUuid()}`;
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

function isTerminalStatus(status: InstanceStatus["status"]) {
  return TERMINAL_STATUSES.has(status);
}

function isPausedStatus(status: InstanceStatus["status"]) {
  return PAUSED_STATUSES.has(status);
}

export const workflowsFragmentDefinition = defineFragment<WorkflowsFragmentConfig>("workflows")
  .extend(withDatabase(workflowsSchema))
  .provideHooks(({ defineHook, config }) => ({
    onWorkflowEnqueued: defineHook(async function (payload: WorkflowEnqueuedHookPayload) {
      if (!config.runner?.tick) {
        return;
      }
      // nextRetryAt is null if the try is immediate, in that case we can use createdAt.
      const timestamp = this.nextRetryAt ?? this.createdAt;
      await config.runner.tick({ ...payload, timestamp });
    }),
  }))
  .providesBaseService(({ defineService, config }) => {
    const randomUuid = () => config.runtime.random.uuid();
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
      validateWorkflowParams,
      createInstance: function (workflowName: string, options?: { id?: string; params?: unknown }) {
        const instanceId = options?.id ?? generateInstanceId(randomUuid);
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
              runNumber: 0,
              startedAt: null,
              completedAt: null,
              output: null,
              errorName: null,
              errorMessage: null,
            });

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              instanceRef: String(instanceRef),
              runNumber: 0,
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
          return this.serviceTx(workflowsSchema)
            .transform(() => [])
            .build();
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
                runNumber: 0,
                startedAt: null,
                completedAt: null,
                output: null,
                errorName: null,
                errorMessage: null,
              });

              uow.triggerHook("onWorkflowEnqueued", {
                workflowName,
                instanceId: instance.id,
                instanceRef: String(instanceRef),
                runNumber: 0,
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
      listHistory: function ({ workflowName, instanceId, runNumber }: ListHistoryParams) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) => {
            return uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b
                  .whereIndex("idx_workflow_step_history_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                      eb("runNumber", "=", runNumber),
                    ),
                  )
                  .orderByIndex("idx_workflow_step_history_createdAt", "desc"),
              )
              .find("workflow_event", (b) =>
                b
                  .whereIndex("idx_workflow_event_history_createdAt", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("instanceId", "=", instanceId),
                      eb("runNumber", "=", runNumber),
                    ),
                  )
                  .orderByIndex("idx_workflow_event_history_createdAt", "desc"),
              );
          })
          .mutate(({ retrieveResult }) => {
            const [instance, steps, events] = retrieveResult as [
              WorkflowInstanceRecord | undefined,
              WorkflowStepRecord[],
              WorkflowEventRecord[],
            ];
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            return {
              runNumber,
              steps: steps.map(buildStepHistoryEntry),
              events: events.map(buildEventHistoryEntry),
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
                    updatedAt: b.now(),
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
                    updatedAt: b.now(),
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
            if (currentStatus !== "paused") {
              return buildInstanceStatus(instance);
            }

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "queued",
                  pauseRequested: false,
                  updatedAt: b.now(),
                })
                .check(),
            );

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              instanceRef: String(instance.id),
              runNumber: instance.runNumber,
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
                  completedAt: b.now(),
                  updatedAt: b.now(),
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
                  updatedAt: b.now(),
                })
                .check(),
            );

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              instanceRef: String(instance.id),
              runNumber: nextRun,
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
                    eb.or(eb.isNull("wakeAt"), eb("wakeAt", ">", eb.now())),
                  ),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, steps] }) => {
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
            const shouldWake =
              currentStatus === "waiting" &&
              !isPausedStatus(currentStatus) &&
              currentRunSteps.some((step) => step.waitEventType === options.type);

            if (shouldWake) {
              uow.triggerHook("onWorkflowEnqueued", {
                workflowName,
                instanceId,
                instanceRef: String(instance.id),
                runNumber: instance.runNumber,
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
