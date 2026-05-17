import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";

// Fragment definition and service implementations for workflow instances.
import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { Cursor, DatabaseHandlerTx } from "@fragno-dev/db";

import { WorkflowsLogger } from "./debug-log";
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

type WorkflowInstanceStatusRecord = {
  status: string;
  output: unknown | null;
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
  result: unknown | null;
  error?: { name: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowsHistoryEvent = {
  id: string;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowsHistoryEmission = {
  id: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  actor: string;
  payload: unknown | null;
  createdAt: Date;
};

export type WorkflowsHistory = {
  steps: WorkflowsHistoryStep[];
  events: WorkflowsHistoryEvent[];
  emissions: WorkflowsHistoryEmission[];
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
      onWorkflowStepEmissionsCleanup: defineHook(async function (payload) {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(workflowsSchema).find("workflow_step_emission", (b) =>
              b.whereIndex(
                "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
                (eb) =>
                  eb.and(
                    eb("instanceRef", "=", payload.instanceId),
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

    const assertWorkflowName = (workflowName: string) => {
      getWorkflowEntry(workflowName);
    };

    const validateWorkflowParams = async (workflowName: string, params: unknown) => {
      const entry = getWorkflowEntry(workflowName);

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
      getInstanceCurrentStep: function (instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("workflow_step", (b) => {
              return b
                .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceId),
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
                  .whereIndex("idx_workflow_instance_workflowName_status_updatedAt", (eb) =>
                    eb.and(eb("workflowName", "=", workflowName), eb("status", "=", status)),
                  )
                  .orderByIndex(
                    "idx_workflow_instance_workflowName_status_updatedAt",
                    effectiveOrder,
                  )
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
      listHistory: function ({ workflowName, instanceId }: ListHistoryParams) {
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
                  .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                    eb("instanceRef", "=", instanceId),
                  )
                  .orderByIndex("idx_workflow_step_instanceRef_createdAt", "desc"),
              )
              .find("workflow_event", (b) =>
                b
                  .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                    eb("instanceRef", "=", instanceId),
                  )
                  .orderByIndex("idx_workflow_event_instanceRef_createdAt", "desc"),
              )
              .find("workflow_step_emission", (b) =>
                b
                  .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                    eb("instanceRef", "=", instanceId),
                  )
                  .orderByIndex(
                    "idx_workflow_step_emission_instance_createdAt_sequence_id",
                    "desc",
                  ),
              );
          })
          .mutate(({ retrieveResult }) => {
            const [instance, steps, events, emissions] = retrieveResult as [
              WorkflowInstanceRecord | undefined,
              WorkflowStepRecord[],
              WorkflowEventRecord[],
              WorkflowStepEmissionRecord[],
            ];
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
      observeStepEmissions: function <TOutEmission = unknown>(params: {
        workflowName: string;
        instanceId: string;
        handlerTx: DatabaseHandlerTx;
      }) {
        assertWorkflowName(params.workflowName);
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
              actor: WORKFLOW_EVENT_ACTOR_USER,
              type: options.type,
              payload: options.payload ?? null,
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
              instanceId: instance.id.toString(),
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
