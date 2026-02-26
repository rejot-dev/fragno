// Fragment definition and service implementations for workflow instances.
import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db";
import type { FragnoId } from "@fragno-dev/db/schema";
import { runWorkflowsTick } from "./new-runner";
import { workflowsSchema } from "./schema";
import {
  isSystemEventActor,
  WORKFLOW_EVENT_ACTOR_SYSTEM,
  WORKFLOW_EVENT_ACTOR_USER,
  WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
} from "./system-events";
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
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
]);

const TERMINAL_STATUSES = new Set<InstanceStatus["status"]>(["complete", "terminated", "errored"]);

type WorkflowInstanceRecord = {
  workflowName: string;
  status: string;
  params: unknown;
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
  actor: string | null;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowsHistoryStep = {
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

export type WorkflowsHistoryEvent = {
  id: string;
  runNumber: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowsHistory = {
  runNumber: number;
  steps: WorkflowsHistoryStep[];
  events: WorkflowsHistoryEvent[];
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
  runNumber?: number;
};

type InstanceDetails = { id: string; details: InstanceStatus };

function generateInstanceId(randomUuid: () => string) {
  const prefix = "inst_";
  const maxLength = 128;
  const raw = randomUuid().replace(/-/g, "");
  const suffixLength = Math.max(maxLength - prefix.length, 0);
  return `${prefix}${raw.slice(0, suffixLength)}`;
}

function buildInstanceStatus(instance: WorkflowInstanceStatusRecord): InstanceStatus {
  if (!INSTANCE_STATUSES.has(instance.status as InstanceStatus["status"])) {
    throw new Error(`INSTANCE_STATUS_INVALID:${instance.status}`);
  }

  const status = instance.status as InstanceStatus["status"];

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

function buildStepHistoryEntry(step: WorkflowStepRecord): WorkflowsHistoryStep {
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

function buildEventHistoryEntry(event: WorkflowEventRecord): WorkflowsHistoryEvent {
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

export const workflowsFragmentDefinition = defineFragment<WorkflowsFragmentConfig>("workflows")
  .extend(withDatabase(workflowsSchema))
  .provideHooks(({ defineHook, config }) => {
    const workflows = config.workflows ?? {};
    const workflowsByName = new Map<string, WorkflowRegistryEntry>();
    for (const entry of Object.values(workflows)) {
      workflowsByName.set(entry.name, entry);
    }
    return {
      onWorkflowEnqueued: defineHook(async function (payload: WorkflowEnqueuedHookPayload) {
        if (config.autoTickHooks === false) {
          return;
        }
        if (workflowsByName.size === 0) {
          return;
        }
        // nextRetryAt is null if the try is immediate, in that case we can use createdAt.
        const timestamp = this.nextRetryAt ?? this.createdAt;
        await runWorkflowsTick({
          handlerTx: this.handlerTx,
          workflowsByName,
          workflows,
          payload: { ...payload, timestamp },
        });
      }),
    };
  })
  .providesBaseService(({ defineService, config }) => {
    const randomUuid = () => config.runtime.random.uuid();
    const workflowsByName = new Map<string, WorkflowRegistryEntry>();

    for (const entry of Object.values(config.workflows ?? {})) {
      workflowsByName.set(entry.name, entry);
    }

    const assertWorkflowName = (workflowName: string) => {
      if (!workflowsByName.has(workflowName)) {
        throw new Error("WORKFLOW_NOT_FOUND");
      }
    };

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
        assertWorkflowName(workflowName);
        const instanceId = options?.id ?? generateInstanceId(randomUuid);
        const params = options?.params ?? {};

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              throw new Error("INSTANCE_ID_ALREADY_EXISTS");
            }

            const instanceRef = uow.create("workflow_instance", {
              id: instanceId,
              workflowName,
              status: "active",
              params,
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
                status: "active",
                output: null,
                errorName: null,
                errorMessage: null,
              }),
            };
          })
          .build();
      },
      createBatch: function (workflowName: string, instances: { id: string; params?: unknown }[]) {
        assertWorkflowName(workflowName);
        if (instances.length === 0) {
          return this.serviceTx(workflowsSchema)
            .transform(() => [])
            .build();
        }

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.find("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(
                  eb("workflowName", "=", workflowName),
                  eb(
                    "id",
                    "in",
                    instances.map((instance) => instance.id),
                  ),
                ),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existingInstances] }) => {
            const existingIds = new Set(existingInstances.map((record) => record.id.toString()));
            const processedIds = new Set<string>();

            const created: InstanceDetails[] = [];

            for (const instance of instances) {
              if (existingIds.has(instance.id) || processedIds.has(instance.id)) {
                continue;
              }
              processedIds.add(instance.id);

              const instanceRef = uow.create("workflow_instance", {
                id: instance.id,
                workflowName,
                status: "active",
                params: instance.params ?? {},
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
                  status: "active",
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
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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
        instanceId,
        runNumber,
      }: {
        instanceId: string;
        runNumber: number;
      }) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("workflow_step", (b) => {
              return b
                .whereIndex("idx_workflow_step_instanceRef_runNumber_createdAt", (eb) =>
                  eb.and(eb("instanceRef", "=", instanceId), eb("runNumber", "=", runNumber)),
                )
                .orderByIndex("idx_workflow_step_instanceRef_runNumber_createdAt", "desc")
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
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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
        assertWorkflowName(workflowName);
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
                .whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                  eb("workflowName", "=", workflowName),
                )
                .orderByIndex("idx_workflow_instance_workflowName_id", effectiveOrder)
                .pageSize(effectivePageSize);

              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(([instances]) => {
            return {
              instances: instances.items.map((instance) => ({
                id: instance.id.toString(),
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
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) => {
            return uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b
                  .whereIndex("idx_workflow_step_instanceRef_runNumber_createdAt", (eb) =>
                    runNumber === undefined
                      ? eb("instanceRef", "=", instanceId)
                      : eb.and(eb("instanceRef", "=", instanceId), eb("runNumber", "=", runNumber)),
                  )
                  .orderByIndex("idx_workflow_step_instanceRef_runNumber_createdAt", "desc"),
              )
              .find("workflow_event", (b) =>
                b
                  .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt", (eb) =>
                    runNumber === undefined
                      ? eb("instanceRef", "=", instanceId)
                      : eb.and(eb("instanceRef", "=", instanceId), eb("runNumber", "=", runNumber)),
                  )
                  .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "desc"),
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

            const resolvedRunNumber = runNumber ?? instance.runNumber;
            const selectedSteps =
              runNumber === undefined
                ? steps.filter((step) => step.runNumber === resolvedRunNumber)
                : steps;
            const selectedEvents =
              runNumber === undefined
                ? events.filter((event) => event.runNumber === resolvedRunNumber)
                : events;

            return {
              runNumber: resolvedRunNumber,
              steps: selectedSteps.map(buildStepHistoryEntry),
              events: selectedEvents
                .filter((event) => !isSystemEventActor(event.actor))
                .map(buildEventHistoryEntry),
            };
          })
          .build();
      },
      pauseInstance: function (workflowName: string, instanceId: string) {
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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

            if (currentStatus === "paused") {
              return buildInstanceStatus(instance);
            }

            uow.create("workflow_event", {
              instanceRef: instance.id,
              runNumber: instance.runNumber,
              actor: WORKFLOW_EVENT_ACTOR_SYSTEM,
              type: WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
              payload: null,
              deliveredAt: null,
              consumedByStepKey: null,
            });

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId: instance.id.toString(),
              instanceRef: String(instance.id),
              runNumber: instance.runNumber,
              reason: "event",
            });

            return buildInstanceStatus(instance);
          })
          .build();
      },
      resumeInstance: function (workflowName: string, instanceId: string) {
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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
                  status: "active",
                  updatedAt: b.now(),
                })
                .check(),
            );

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId: instance.id.toString(),
              instanceRef: String(instance.id),
              runNumber: instance.runNumber,
              reason: "resume",
            });

            return buildInstanceStatus({
              status: "active",
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      terminateInstance: function (workflowName: string, instanceId: string) {
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
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
                  status: "active",
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
              instanceId: instance.id.toString(),
              instanceRef: String(instance.id),
              runNumber: nextRun,
              reason: "create",
            });

            return buildInstanceStatus({
              status: "active",
              output: null,
              errorName: null,
              errorMessage: null,
            });
          })
          .build();
      },
      /**
       * Send an event to a workflow instance. Wakes the instance if it is waiting for this event type.
       *
       * @param options.type - Event type (must match waitForEvent filter).
       * @param options.payload - Optional payload attached to the event.
       * @param options.createdAt - Internal: when to backdate the event. Used by scenario tests for deterministic ordering. Not exposed to users.
       */
      sendEvent: function (
        workflowName: string,
        instanceId: string,
        options: { type: string; payload?: unknown; createdAt?: Date },
      ) {
        assertWorkflowName(workflowName);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_instanceRef_status_wakeAt", (eb) =>
                  eb.and(
                    eb("instanceRef", "=", instanceId),
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
              runNumber: instance.runNumber,
              actor: WORKFLOW_EVENT_ACTOR_USER,
              type: options.type,
              payload: options.payload ?? null,
              ...(options.createdAt ? { createdAt: options.createdAt } : {}),
              deliveredAt: null,
              consumedByStepKey: null,
            });

            const currentRunSteps = steps.filter((step) => step.runNumber === instance.runNumber);
            const shouldWake =
              currentStatus === "waiting" &&
              currentRunSteps.some((step) => step.waitEventType === options.type);

            if (shouldWake) {
              uow.triggerHook("onWorkflowEnqueued", {
                workflowName,
                instanceId: instance.id.toString(),
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
