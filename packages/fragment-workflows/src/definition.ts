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
import { selectCanonicalWorkflowStepEmissions } from "./step-emission-control";
import {
  isSystemEventActor,
  WORKFLOW_EVENT_ACTOR_SYSTEM,
  WORKFLOW_EVENT_ACTOR_USER,
  WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE,
  type WorkflowEventActor,
} from "./system-events";
import {
  WorkflowFailedStepNotRetryableError,
  WorkflowInstanceNotErroredError,
  WorkflowInstanceNotFoundError,
  WorkflowNotFoundError,
  WorkflowParamsInvalidError,
  type InstanceStatus,
  type WorkflowEnqueuedHookPayload,
  type WorkflowInstanceCurrentStep,
  type WorkflowInstanceMetadata,
  type WorkflowRegistryEntry,
  type WorkflowRestartOrCreateOptions,
  type WorkflowRestartedHookPayload,
  type WorkflowStepEmissionsCleanupHookPayload,
  type WorkflowTerminalHookPayload,
  type WorkflowsFragmentConfig,
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
  runGeneration: number;
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
  committedByExecutionId: string;
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
  executionId: string;
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

type RetryFailedStepParams = {
  delayMs?: number;
};

type RetryFailedStepResult = {
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
    runGeneration: instance.runGeneration,
    error,
    output: instance.output ?? undefined,
  };
}

function buildInstanceMetadata(instance: WorkflowInstanceRecord): WorkflowInstanceMetadata {
  return {
    workflowName: instance.workflowName,
    remoteWorkflowName: instance.remoteWorkflowName ?? undefined,
    runGeneration: instance.runGeneration,
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
    committedByExecutionId: step.committedByExecutionId,
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
    executionId: emission.executionId,
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

function findRetryableFailedTopLevelStep(
  steps: WorkflowStepRecord[],
): WorkflowStepRecord | undefined {
  const topLevelSteps = steps.filter((step) => step.parentStepKey === null);
  const latestTopLevelStep = topLevelSteps[0];
  const failedTopLevelSteps = topLevelSteps.filter((step) => step.status === "errored");

  if (
    latestTopLevelStep?.status !== "errored" ||
    (latestTopLevelStep.type !== "do" && latestTopLevelStep.type !== "waitForEvent") ||
    failedTopLevelSteps.length !== 1
  ) {
    return undefined;
  }

  return latestTopLevelStep;
}

function isStepInRetrySubtree(stepKey: string, retriedStepKey: string) {
  return stepKey === retriedStepKey || stepKey.startsWith(`${retriedStepKey}>`);
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
    throw new WorkflowNotFoundError(workflowName);
  }

  if (!entry.schema) {
    return params ?? {};
  }

  const result = await entry.schema["~standard"].validate(params ?? {});
  if (result.issues) {
    throw new WorkflowParamsInvalidError(workflowName, result.issues);
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
          createExecutionId: () => config.runtime.random.uuid(),
          createEpoch: () => config.runtime.random.uuid(),
          stepEmissions: deps.stepEmissions,
          payload: { ...payload, timestamp },
        });
      }),
      onWorkflowRestarted: defineHook(async function (payload: WorkflowRestartedHookPayload) {
        await config.onWorkflowRestarted?.(payload);
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
              b
                .whereIndex(
                  "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
                  (eb) =>
                    eb.and(
                      eb("instanceRef", "=", payload.instanceRef),
                      eb("stepKey", "=", payload.stepKey),
                      eb("epoch", "=", payload.epoch),
                    ),
                )
                .withOutboxMutations(),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [rows] }) => {
            const workflows = forSchema(workflowsSchema);
            for (const row of rows) {
              workflows.delete("workflow_step_emission", row.id, (b) => b.check().omitOutbox());
              for (const mutation of row.$outboxMutations) {
                workflows.outbox.deleteMutation(mutation.id);
              }
            }

            if (rows.length > 0) {
              workflows.outbox.notifyTruncate("workflow_step_emission", {
                match: {
                  instanceRef: payload.instanceRef,
                  stepKey: payload.stepKey,
                  epoch: payload.epoch,
                },
                externalIds: rows.map((row) => row.id.externalId),
              });
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
        throw new WorkflowNotFoundError(workflowName);
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
                runGeneration: 1,
                output: null,
                errorName: null,
                errorMessage: null,
              }),
            };
          })
          .build();
      },
      restartOrCreateInstance: function (
        workflowName: string,
        options: WorkflowRestartOrCreateOptions,
      ) {
        getWorkflowEntry(workflowName);

        const { id: instanceId } = options;
        const restartableStatuses = new Set(options.restart.precondition.status.in);
        const requiredRunGeneration = options.restart.precondition.runGeneration?.equals;
        const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              )
              .find("workflow_event", (b) =>
                b.whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              )
              .find("workflow_step_emission", (b) =>
                b.whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, steps, events, emissions] }) => {
            if (!instance) {
              uow.checkAbsent("workflow_instance", "primary", { id: instanceRef });
              const operation = validateAndNormalizeWorkflowOperation(deps.workflowsByName, {
                type: "createInstance",
                workflowName,
                instanceId,
                params: options.create.params ?? {},
                remoteWorkflowName: options.create.remoteWorkflowName,
              });
              const createdInstanceRef = uow.create(
                "workflow_instance",
                {
                  id: instanceRef,
                  workflowName,
                  remoteWorkflowName: operation.remoteWorkflowName,
                  instanceId,
                  status: "active",
                  params: operation.params,
                  startedAt: null,
                  completedAt: null,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                },
                { retryOnUniqueConflict: () => true },
              );

              uow.triggerHook("onWorkflowEnqueued", {
                workflowName,
                instanceId,
                instanceRef: String(createdInstanceRef),
                reason: "create",
              });

              return {
                action: "created" as const,
                id: instanceId,
                details: buildInstanceStatus({
                  status: "active",
                  runGeneration: 1,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                }),
              };
            }

            const observedStatus = instance.status as InstanceStatus["status"];
            if (
              !restartableStatuses.has(observedStatus) ||
              (requiredRunGeneration !== undefined &&
                instance.runGeneration !== requiredRunGeneration)
            ) {
              return {
                action: "unchanged" as const,
                observedStatus,
                id: instanceId,
                details: buildInstanceStatus(instance),
              };
            }

            for (const step of steps) {
              uow.delete("workflow_step", step.id);
            }
            for (const emission of emissions) {
              uow.delete("workflow_step_emission", emission.id);
            }
            for (const event of events) {
              uow.delete("workflow_event", event.id);
            }

            const previousStatus = observedStatus;
            const nextRunGeneration = instance.runGeneration + 1;
            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "active",
                  runGeneration: nextRunGeneration,
                  startedAt: null,
                  completedAt: null,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                  updatedAt: b.now(),
                })
                .check(),
            );
            uow.triggerHook("onWorkflowRestarted", {
              workflowName,
              instanceId,
              instanceRef: String(instance.id),
              previousRunGeneration: instance.runGeneration,
              runGeneration: nextRunGeneration,
            } satisfies WorkflowRestartedHookPayload);
            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId,
              instanceRef: String(instance.id),
              reason: "create",
            });

            return {
              action: "restarted" as const,
              previousStatus,
              id: instanceId,
              details: buildInstanceStatus({
                status: "active",
                runGeneration: nextRunGeneration,
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
                  runGeneration: 1,
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
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
              const query = b
                .whereIndex("idx_workflow_instance_list", (eb) => {
                  if (remoteWorkflowName && status) {
                    return eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("remoteWorkflowName", "=", remoteWorkflowName),
                      eb("status", "=", status),
                    );
                  }
                  if (remoteWorkflowName) {
                    return eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("remoteWorkflowName", "=", remoteWorkflowName),
                    );
                  }
                  if (status) {
                    return eb.and(eb("workflowName", "=", workflowName), eb("status", "=", status));
                  }
                  return eb("workflowName", "=", workflowName);
                })
                .orderByIndex("idx_workflow_instance_list", effectiveOrder)
                .pageSize(effectivePageSize);

              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(([instances]) => {
            return {
              instances: instances.items.map((instance) => ({
                id: instance.instanceId,
                details: buildInstanceStatus(instance),
                params: instance.params ?? {},
                createdAt: instance.createdAt,
                updatedAt: instance.updatedAt,
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
            }

            const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
              steps,
              emissions,
            });

            return {
              steps: steps.map(buildStepHistoryEntry),
              events: events.flatMap((event) =>
                isSystemEventActor(event.actor) ? [] : [buildEventHistoryEntry(event)],
              ),
              emissions: canonicalEmissions.map(buildEmissionHistoryEntry),
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
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
              runGeneration: instance.runGeneration,
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      restartInstance: function (workflowName: string, instanceId: string) {
        getWorkflowEntry(workflowName);

        const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              )
              .find("workflow_event", (b) =>
                b.whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              )
              .find("workflow_step_emission", (b) =>
                b.whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, steps, events, emissions] }) => {
            if (!instance) {
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
            }

            for (const step of steps) {
              uow.delete("workflow_step", step.id);
            }
            for (const emission of emissions) {
              uow.delete("workflow_step_emission", emission.id);
            }
            for (const event of events) {
              uow.delete("workflow_event", event.id);
            }

            const nextRunGeneration = instance.runGeneration + 1;
            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "active",
                  runGeneration: nextRunGeneration,
                  startedAt: null,
                  completedAt: null,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                  updatedAt: b.now(),
                })
                .check(),
            );
            uow.triggerHook("onWorkflowRestarted", {
              workflowName,
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
              previousRunGeneration: instance.runGeneration,
              runGeneration: nextRunGeneration,
            } satisfies WorkflowRestartedHookPayload);
            uow.triggerHook("onWorkflowEnqueued", {
              workflowName,
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
              reason: "create",
            });

            return buildInstanceStatus({
              status: "active",
              runGeneration: nextRunGeneration,
              output: null,
              errorName: null,
              errorMessage: null,
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
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
              terminalTransitionId: uow.idempotencyKey,
              workflowName: instance.workflowName,
              instanceId: instance.instanceId,
              instanceRef: String(instance.id),
              runGeneration: instance.runGeneration,
              status: "terminated",
              params: instance.params,
              ...(instance.output == null ? {} : { output: instance.output }),
              ...(instance.errorName || instance.errorMessage
                ? {
                    error: {
                      name: instance.errorName ?? "Error",
                      message: instance.errorMessage ?? "",
                    },
                  }
                : {}),
            } satisfies WorkflowTerminalHookPayload);
            return buildInstanceStatus({
              status: "terminated",
              runGeneration: instance.runGeneration,
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      retryFailedStep: function (
        workflowName: string,
        instanceId: string,
        options?: RetryFailedStepParams,
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
              )
              .find("workflow_event", (b) =>
                b.whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              )
              .find("workflow_step_emission", (b) =>
                b.whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                  eb("instanceRef", "=", instanceRef),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult }): RetryFailedStepResult => {
            const [instance, steps, events, emissions] = retrieveResult;
            if (!instance) {
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
            }
            if (instance.status !== "errored") {
              throw new WorkflowInstanceNotErroredError(workflowName, instanceId);
            }

            const failedStep = findRetryableFailedTopLevelStep(steps);
            if (!failedStep) {
              throw new WorkflowFailedStepNotRetryableError(workflowName, instanceId);
            }
            const retrySubtree = steps.filter((step) =>
              isStepInRetrySubtree(step.stepKey, failedStep.stepKey),
            );
            const descendantSteps = retrySubtree.filter(
              (step) => step.stepKey !== failedStep.stepKey,
            );
            const retryStepKeys = new Set(retrySubtree.map((step) => step.stepKey));

            for (const descendant of descendantSteps) {
              uow.delete("workflow_step", descendant.id);
            }
            for (const emission of emissions) {
              if (retryStepKeys.has(emission.stepKey)) {
                uow.delete("workflow_step_emission", emission.id);
              }
            }
            for (const event of events) {
              if (
                event.consumedByStepKey &&
                isStepInRetrySubtree(event.consumedByStepKey, failedStep.stepKey)
              ) {
                uow.update("workflow_event", event.id, (b) =>
                  b.set({ consumedByStepKey: null, deliveredAt: null }),
                );
              }
            }

            const maxAttempts =
              failedStep.type === "do"
                ? Math.max(failedStep.maxAttempts, failedStep.attempts + 1)
                : failedStep.maxAttempts;

            if (failedStep.type === "do") {
              uow.update("workflow_step", failedStep.id, (b) =>
                b
                  .set({
                    status: "waiting",
                    maxAttempts,
                    result: null,
                    errorName: null,
                    errorMessage: null,
                    nextRetryAt: scheduledAt,
                    wakeAt: null,
                    updatedAt: b.now(),
                  })
                  .check(),
              );
            } else {
              // Removing a failed wait gives replay a new timeout window and makes all pending
              // events eligible again instead of preserving the expired wait deadline.
              uow.delete("workflow_step", failedStep.id);
            }
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
                reason: "retry",
              },
              { processAt: scheduledAt },
            );

            return {
              accepted: true,
              instance: {
                id: instance.instanceId,
                details: buildInstanceStatus({
                  status: "waiting",
                  runGeneration: instance.runGeneration,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                }),
              },
              retry: {
                stepKey: failedStep.stepKey,
                attempts: failedStep.attempts,
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
       * @param options.expectedRemoteWorkflowName - Validates that the persisted instance belongs to the expected remote workflow.
       * @param options.createdAt - Internal: when to backdate the event. Used by scenario tests for deterministic ordering. Not exposed to users.
       */
      sendEvent: function (
        workflowName: string,
        instanceId: string,
        options: {
          id?: string;
          type: string;
          payload?: unknown;
          expectedRemoteWorkflowName?: string;
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
              throw new WorkflowInstanceNotFoundError(workflowName, instanceId);
            }

            if (
              options.expectedRemoteWorkflowName !== undefined &&
              instance.remoteWorkflowName !== options.expectedRemoteWorkflowName
            ) {
              throw new Error("INSTANCE_REMOTE_WORKFLOW_MISMATCH");
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
