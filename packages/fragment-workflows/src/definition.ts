import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";

// Fragment definition and service implementations for workflow instances.
import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { Cursor, DatabaseHandlerTx } from "@fragno-dev/db";

import { WorkflowsLogger } from "./debug-log";
import { buildScopedInstanceRowId } from "./instance-ref";
import { runWorkflowsTick } from "./new-runner";
import { createWorkflowStepLivePump, workflowStepLivePumpKey } from "./runner/step-live-pump";
import type { WorkflowStepLivePump, WorkflowStepLivePumpHandle } from "./runner/step-live-pump";
import type {
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowStepEmissionRecord,
  WorkflowStepRecord,
} from "./runner/types";
import { workflowsSchema } from "./schema";
import {
  isSystemEventActor,
  WORKFLOW_EVENT_ACTOR_SYSTEM,
  WORKFLOW_EVENT_ACTOR_USER,
  WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
  type WorkflowEventActor,
} from "./system-events";
import type {
  InstanceStatus,
  WorkflowEnqueuedHookPayload,
  WorkflowInstanceCurrentStep,
  WorkflowInstanceMetadata,
  WorkflowRegistryEntry,
  WorkflowStepEmissionsCleanupHookPayload,
  WorkflowTerminalHookPayload,
  WorkflowsFragmentConfig,
} from "./workflow";
import { validateAndNormalizeWorkflowOperation } from "./workflow-operation";

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

type WorkflowInstanceStatusRecord = {
  status: string;
  output: unknown;
  errorName: string | null;
  errorMessage: string | null;
};

export type WorkflowsHistoryStep = {
  id: string;
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number | null;
  nextRetryAt: Date | null;
  wakeAt: Date | null;
  waitEventType: string | null;
  result: unknown;
  error?: { name: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowsHistoryEvent = {
  id: string;
  type: string;
  payload: unknown;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowsHistoryEmission = {
  id: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  actor: WorkflowEventActor;
  payload: unknown;
  createdAt: Date;
};

export type WorkflowsHistory = {
  steps: WorkflowsHistoryStep[];
  events: WorkflowsHistoryEvent[];
  emissions: WorkflowsHistoryEmission[];
};

type ListInstancesParams = {
  workflowName: string;
  remoteWorkflowName?: string;
  status?: InstanceStatus["status"];
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type ListHistoryParams = {
  workflowName: string;
  instanceId: string;
};

type RetryInstanceParams = {
  stepKey?: string;
  delayMs?: number;
};

type RetryInstanceResult = {
  accepted: true;
  instance: InstanceDetails;
  retry: {
    stepKey: string;
    attempts: number;
    maxAttempts: number;
    scheduledAt: Date;
  };
};

type InstanceDetails = { id: string; details: InstanceStatus };

function generateInstanceId(randomUuid: () => string) {
  const prefix = "inst_";
  const maxLength = 128;
  const raw = randomUuid().replace(/-/g, "");
  const suffixLength = Math.max(maxLength - prefix.length, 0);
  return `${prefix}${raw.slice(0, suffixLength)}`;
}

export function buildInstanceStatus(instance: WorkflowInstanceStatusRecord): InstanceStatus {
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
    remoteWorkflowName: instance.remoteWorkflowName ?? undefined,
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
    parentStepKey: step.parentStepKey,
    depth: step.depth,
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
    stepKey: step.stepKey,
    parentStepKey: step.parentStepKey,
    depth: step.depth,
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
    type: event.type,
    payload: event.payload ?? null,
    createdAt: event.createdAt,
    deliveredAt: event.deliveredAt,
    consumedByStepKey: event.consumedByStepKey,
  };
}

function buildEmissionHistoryEntry(emission: WorkflowStepEmissionRecord): WorkflowsHistoryEmission {
  return {
    id: emission.id.toString(),
    stepKey: emission.stepKey,
    epoch: emission.epoch,
    sequence: emission.sequence,
    actor: emission.actor,
    payload: emission.payload ?? null,
    createdAt: emission.createdAt,
  };
}

function isTerminalStatus(status: InstanceStatus["status"]) {
  return TERMINAL_STATUSES.has(status);
}

function isRetryTaskStep(step: WorkflowStepRecord) {
  return step.type === "do";
}

function getRetryHookReason(step: WorkflowStepRecord): WorkflowEnqueuedHookPayload["reason"] {
  return isRetryTaskStep(step) ? "retry" : "wake";
}

export const validateWorkflowParams = async (
  workflowsByName: ReadonlyMap<
    string,
    { schema?: WorkflowRegistryEntry["schema"]; workflow?: unknown }
  >,
  workflowName: string,
  params: unknown,
): Promise<unknown> => {
  const entry = workflowsByName.get(workflowName);
  if (!entry) {
    throw new Error("WORKFLOW_NOT_FOUND");
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

  return result.value as unknown;
};

export const workflowsFragmentDefinition = defineFragment<WorkflowsFragmentConfig>("workflows")
  .extend(withDatabase(workflowsSchema))
  .withDependencies(({ config }) => {
    const workflows = config.workflows ?? {};
    const stepEmissions = config.stepEmissions ?? new BufferedPumpRegistry<WorkflowStepLivePump>();
    const workflowsByName = new Map<string, WorkflowRegistryEntry>();
    for (const entry of Object.values(workflows)) {
      workflowsByName.set(entry.name, entry);
    }

    return { stepEmissions, workflowsByName };
  })
  .provideHooks(({ defineHook, config, deps }) => {
    return {
      onWorkflowEnqueued: defineHook(async function (payload: WorkflowEnqueuedHookPayload) {
        if (config.autoTickHooks === false) {
          return;
        }
        if (deps.workflowsByName.size === 0) {
          return;
        }
        // nextRetryAt is null if the try is immediate, in that case we can use createdAt.
        const timestamp = this.nextRetryAt ?? this.createdAt;
        await runWorkflowsTick({
          handlerTx: this.handlerTx,
          busHandlerTx: this.handlerTx,
          workflowsByName: deps.workflowsByName,
          workflows: config.workflows ?? {},
          createEpoch: () => config.runtime.random.uuid(),
          stepEmissions: deps.stepEmissions,
          payload: { ...payload, timestamp },
        });
      }),
      onWorkflowTerminal: defineHook(async function (payload: WorkflowTerminalHookPayload) {
        await config.onWorkflowTerminal?.(payload);
      }),
      onWorkflowStepEmissionsCleanup: defineHook(async function (
        payload: WorkflowStepEmissionsCleanupHookPayload,
      ) {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).find("workflow_step_emission", (b) =>
              b.whereIndex(
                "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
                (eb) =>
                  eb.and(
                    eb("instanceRef", "=", payload.instanceRef),
                    eb("stepKey", "=", payload.stepKey),
                    eb("epoch", "=", payload.epoch),
                  ),
              ),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [rows] }) => {
            const uow = forSchema(workflowsSchema);
            for (const row of rows) {
              uow.delete("workflow_step_emission", row.id);
            }
          })
          .execute();
      }),
    };
  })
  .providesBaseService(({ defineService, config, deps }) => {
    WorkflowsLogger.configure(config.logging);

    const randomUuid = () => config.runtime.random.uuid();

    const getWorkflowEntry = (workflowName: string) => {
      const entry = deps.workflowsByName.get(workflowName);
      if (!entry) {
        throw new Error("WORKFLOW_NOT_FOUND");
      }
      return entry;
    };

    const normalizeEventPayload = (payload: unknown) => payload ?? null;

    return defineService({
      createInstance: function (
        workflowName: string,
        options?: { id?: string; params?: unknown; remoteWorkflowName?: string },
      ) {
        const instanceId = options?.id ?? generateInstanceId(randomUuid);
        const operation = validateAndNormalizeWorkflowOperation(deps.workflowsByName, {
          type: "createInstance",
          workflowName,
          instanceId,
          params: options?.params ?? {},
          remoteWorkflowName: options?.remoteWorkflowName,
        });
        const remoteWorkflowName = operation.remoteWorkflowName;
        const params = operation.params;

        return this.serviceTx(workflowsSchema)
          .mutate(({ uow }) => {
            const instanceRef = uow.create("workflow_instance", {
              id: buildScopedInstanceRowId(workflowName, instanceId),
              workflowName,
              remoteWorkflowName: remoteWorkflowName ?? null,
              instanceId,
              status: "active",
              params,
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
      createBatch: function (
        workflowName: string,
        instances: { id: string; params?: unknown }[],
        options?: { remoteWorkflowName?: string },
      ) {
        getWorkflowEntry(workflowName);
        const remoteWorkflowName = options?.remoteWorkflowName;
        validateAndNormalizeWorkflowOperation(deps.workflowsByName, {
          type: "createInstance",
          workflowName,
          instanceId: "__validation__",
          params: {},
          remoteWorkflowName,
        });
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
                id: buildScopedInstanceRowId(workflowName, instance.id),
                workflowName,
                remoteWorkflowName: remoteWorkflowName ?? null,
                instanceId: instance.id,
                status: "active",
                params: instance.params ?? {},
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
      getInstanceCurrentStep: function (workflowName: string, instanceId: string) {
        const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("workflow_step", (b) => {
              return b
                .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                )
                .orderByIndex("idx_workflow_step_instanceRef_createdAt", "desc")
                .pageSize(1);
            }),
          )
          .transformRetrieve(([steps]) => {
            const latest = steps.items[0];
            return latest ? buildCurrentStepSummary(latest) : undefined;
          })
          .build();
      },
      listInstances: function ({
        workflowName,
        remoteWorkflowName,
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
              if (remoteWorkflowName && status) {
                const query = b
                  .whereIndex(
                    "idx_workflow_instance_workflowName_remoteWorkflowName_status_instanceId",
                    (eb) =>
                      eb.and(
                        eb("workflowName", "=", workflowName),
                        eb("remoteWorkflowName", "=", remoteWorkflowName),
                        eb("status", "=", status),
                      ),
                  )
                  .orderByIndex(
                    "idx_workflow_instance_workflowName_remoteWorkflowName_status_instanceId",
                    effectiveOrder,
                  )
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }

              if (remoteWorkflowName) {
                const query = b
                  .whereIndex(
                    "idx_workflow_instance_workflowName_remoteWorkflowName_instanceId",
                    (eb) =>
                      eb.and(
                        eb("workflowName", "=", workflowName),
                        eb("remoteWorkflowName", "=", remoteWorkflowName),
                      ),
                  )
                  .orderByIndex(
                    "idx_workflow_instance_workflowName_remoteWorkflowName_instanceId",
                    effectiveOrder,
                  )
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }

              if (status) {
                const query = b
                  .whereIndex("idx_workflow_instance_workflowName_status_instanceId", (eb) =>
                    eb.and(eb("workflowName", "=", workflowName), eb("status", "=", status)),
                  )
                  .orderByIndex(
                    "idx_workflow_instance_workflowName_status_instanceId",
                    effectiveOrder,
                  )
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
      listHistory: function ({ workflowName, instanceId }: ListHistoryParams) {
        const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);
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
                  .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                    eb("instanceRef", "=", instanceRef),
                  )
                  .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
              )
              .find("workflow_event", (b) =>
                b
                  .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                    eb("instanceRef", "=", instanceRef),
                  )
                  .orderByIndex("idx_workflow_event_instanceRef_createdAt", "asc"),
              )
              .find("workflow_step_emission", (b) =>
                b
                  .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                    eb("instanceRef", "=", instanceRef),
                  )
                  .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", "asc"),
              );
          })
          .mutate(({ retrieveResult }) => {
            const [instance, steps, events, emissions] = retrieveResult;
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            return {
              steps: steps.map(buildStepHistoryEntry),
              events: events
                .filter((event) => !isSystemEventActor(event.actor))
                .map(buildEventHistoryEntry),
              emissions: emissions.map(buildEmissionHistoryEntry),
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

            if (currentStatus === "paused") {
              return buildInstanceStatus(instance);
            }

            uow.create("workflow_event", {
              instanceRef: instance.id,
              actor: WORKFLOW_EVENT_ACTOR_SYSTEM,
              type: WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
              payload: null,
              deliveredAt: null,
              consumedByStepKey: null,
            });

            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
              reason: "event",
            });

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
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

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
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
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
                })
                .check(),
            );
            uow.triggerHook("onWorkflowTerminal", {
              workflowName: instance.workflowName,
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
              status: "terminated",
            } satisfies WorkflowTerminalHookPayload);
            return buildInstanceStatus({
              status: "terminated",
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      retryInstance: function (
        workflowName: string,
        instanceId: string,
        options?: RetryInstanceParams,
      ) {
        getWorkflowEntry(workflowName);

        const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);
        const delayMs = options?.delayMs ?? 0;
        const scheduledAt = new Date(config.runtime.time.now().getTime() + delayMs);

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b
                  .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                    eb("instanceRef", "=", instanceRef),
                  )
                  .orderByIndex("idx_workflow_step_instanceRef_createdAt", "desc"),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, steps] }): RetryInstanceResult => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const step = options?.stepKey
              ? steps.find((candidate) => candidate.stepKey === options.stepKey)
              : steps[0];

            if (!step) {
              throw new Error("STEP_NOT_FOUND");
            }

            const isRetryTask = isRetryTaskStep(step);
            const maxAttempts = isRetryTask
              ? Math.max(step.maxAttempts, step.attempts + 1)
              : step.maxAttempts;

            uow.update("workflow_step", step.id, (b) =>
              b
                .set({
                  status: "waiting",
                  maxAttempts,
                  result: null,
                  nextRetryAt: isRetryTask ? scheduledAt : null,
                  wakeAt: isRetryTask ? null : scheduledAt,
                  updatedAt: b.now(),
                })
                .check(),
            );
            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "waiting",
                  output: null,
                  errorName: null,
                  errorMessage: null,
                  completedAt: null,
                  updatedAt: b.now(),
                })
                .check(),
            );
            uow.triggerHook(
              "onWorkflowEnqueued",
              {
                workflowName,
                instanceId: instance.instanceId,
                instanceRef: String(instance.id),
                reason: getRetryHookReason(step),
              },
              { processAt: scheduledAt },
            );

            return {
              accepted: true,
              instance: {
                id: instance.instanceId,
                details: buildInstanceStatus({
                  status: "waiting",
                  output: null,
                  errorName: null,
                  errorMessage: null,
                }),
              },
              retry: {
                stepKey: step.stepKey,
                attempts: step.attempts,
                maxAttempts,
                scheduledAt,
              },
            };
          })
          .build();
      },
      observeStepEmissions: function <TOutEmission = unknown>(params: {
        workflowName: string;
        instanceId: string;
        handlerTx: DatabaseHandlerTx;
      }) {
        const handle = deps.stepEmissions.getOrCreate(
          workflowStepLivePumpKey(params.workflowName, params.instanceId),
          () =>
            createWorkflowStepLivePump({
              handlerTx: params.handlerTx,
              workflowName: params.workflowName,
              instanceId: params.instanceId,
            }),
        );
        handle.pump.setHandlerTx(params.handlerTx);
        return handle as WorkflowStepLivePumpHandle<TOutEmission>;
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
        options: {
          id?: string;
          type: string;
          payload?: unknown;
          createdAt?: Date;
          ignoreTerminal?: boolean;
        },
      ) {
        const eventId = options.id ?? randomUuid();
        const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .findFirst("workflow_event", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", eventId)),
              )
              .find("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_instanceRef_status_wakeAt", (eb) =>
                  eb.and(
                    eb("instanceRef", "=", instanceRef),
                    eb("status", "=", "waiting"),
                    eb.or(eb.isNull("wakeAt"), eb("wakeAt", ">", eb.now())),
                  ),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, existingEvent, steps] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            if (existingEvent) {
              if (
                instance.id.internalId === undefined ||
                existingEvent.instanceRef.internalId !== instance.id.internalId
              ) {
                throw new Error("EVENT_ID_CONFLICT");
              }
              return buildInstanceStatus(instance);
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              if (options.ignoreTerminal) {
                return buildInstanceStatus(instance);
              }
              throw new Error("INSTANCE_TERMINAL");
            }

            uow.create("workflow_event", {
              ...(options.id ? { id: options.id } : {}),
              instanceRef: instance.id,
              actor: WORKFLOW_EVENT_ACTOR_USER,
              type: options.type,
              payload: normalizeEventPayload(options.payload),
              ...(options.createdAt ? { createdAt: options.createdAt } : {}),
              deliveredAt: null,
              consumedByStepKey: null,
            });

            WorkflowsLogger.debug("sendEvent wake", () => ({
              workflowName,
              instanceId,
              eventType: options.type,
              status: currentStatus,
              waitingSteps: steps.filter((step) => step.status === "waiting").length,
              reason: "event-created",
            }));
            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
              reason: "event",
            });

            return buildInstanceStatus(instance);
          })
          .build();
      },
    });
  })
  .build();
