import {
  BufferedDatabasePump,
  BufferedPumpRegistry,
  type BufferedFlushContext,
  type BufferedFlushResult,
  type BufferedPumpHandle,
  type BufferedPumpScope,
} from "@fragno-dev/db/buffered-pump";

import type { DatabaseRequestContext } from "@fragno-dev/db";

import { buildScopedInstanceRowId } from "../instance-ref";
import { workflowsSchema } from "../schema";
import {
  isSystemEventActor,
  WORKFLOW_EVENT_ACTOR_SYSTEM,
  WORKFLOW_EVENT_ACTOR_USER,
} from "../system-events";
import type { WorkflowStepEvent } from "../workflow";
import type { WorkflowEventRecord } from "./types";

const WORKFLOW_STEP_EMISSION_PUMP_INTERVAL_MS = 100;

const STEP_STARTED_PAYLOAD = { control: "step-started" as const };

type StepEmissionOpenScopeMeta = {
  stepKey: string;
  epoch: string;
  queueEventConsumption: (event: WorkflowEventRecord, consumedByStepKey: string) => void;
  isEventConsumptionQueued: (event: WorkflowEventRecord) => boolean;
};

type StepEmissionScopeOptions = StepEmissionOpenScopeMeta & {
  eventTypeCounts: Map<string, number>;
};

type StepEmissionScopeMeta = StepEmissionScopeOptions;

export type WorkflowStepEmissionScope<
  TOutEmission = unknown,
  TInEvent = unknown,
> = BufferedPumpScope<TOutEmission, WorkflowStepEvent<TInEvent>, StepEmissionScopeMeta>;

export type WorkflowStepEmission<TMessage = unknown> = {
  id: string;
  actor: "user" | "system" | string;
  stepKey: string;
  epoch: string;
  sequence: number;
  payload: TMessage;
  createdAt: Date;
};

type StepEmissionFlushContext<TOutEmission> = BufferedFlushContext<
  TOutEmission,
  StepEmissionScopeMeta
>;

export type WorkflowStepEmissionSnapshot<TOutEmission> = WorkflowStepEmission<TOutEmission>[];

export type WorkflowStepLivePump<TOutEmission = unknown, TInEvent = unknown> = BufferedDatabasePump<
  TOutEmission,
  StepEmissionScopeMeta,
  WorkflowStepEmission<TOutEmission>,
  WorkflowStepEvent<TInEvent>,
  StepEmissionOpenScopeMeta
>;

export type WorkflowStepLivePumpRegistry = BufferedPumpRegistry<WorkflowStepLivePump>;

export type WorkflowStepLivePumpHandle<
  TOutEmission = unknown,
  TInEvent = unknown,
> = BufferedPumpHandle<WorkflowStepLivePump<TOutEmission, TInEvent>>;

export const workflowStepLivePumpKey = (workflowName: string, instanceId: string): string =>
  `${workflowName}\u0000${instanceId}`;

type LogicalStepEmissionRow = {
  id: string;
  actor: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  payload: unknown;
  createdAt: Date;
};

export type WorkflowStepLivePumpOptions = {
  handlerTx: DatabaseRequestContext["handlerTx"];
  workflowName: string;
  instanceId: string;
};

export function createWorkflowStepLivePump<TOutEmission = unknown, TInEvent = unknown>(
  options: WorkflowStepLivePumpOptions,
): WorkflowStepLivePump<TOutEmission, TInEvent> {
  return new BufferedDatabasePump<
    TOutEmission,
    StepEmissionScopeMeta,
    WorkflowStepEmission<TOutEmission>,
    WorkflowStepEvent<TInEvent>,
    StepEmissionOpenScopeMeta
  >({
    handlerTx: options.handlerTx,
    intervalMs: WORKFLOW_STEP_EMISSION_PUMP_INTERVAL_MS,
    onError: (error) => console.error("[step-live-pump] flush failed", error),
    flush: (context: StepEmissionFlushContext<TOutEmission>) =>
      writeWorkflowStepEmissionFlush<TOutEmission, TInEvent>({
        handlerTx: context.handlerTx,
        workflowName: options.workflowName,
        instanceId: options.instanceId,
        scopes: context.scopes,
        batch: context.batch,
      }),
    cursorForObservedItem: (item) => item.id,
    resolveScopeMeta: ({ key, meta }) => {
      if (!meta) {
        throw new Error("STEP_SCOPE_META_REQUIRED");
      }
      if (meta.stepKey !== key) {
        throw new Error("STEP_SCOPE_KEY_MISMATCH");
      }

      return {
        stepKey: key,
        epoch: meta.epoch,
        queueEventConsumption: meta.queueEventConsumption,
        isEventConsumptionQueued: meta.isEventConsumptionQueued,
        eventTypeCounts: new Map<string, number>(),
      };
    },
    debugLabel: () => `${options.workflowName}:${options.instanceId}`,
  });
}

const writeWorkflowStepEmissionFlush = async <TOutEmission, TInEvent>(options: {
  handlerTx: DatabaseRequestContext["handlerTx"];
  workflowName: string;
  instanceId: string;
  scopes: ReadonlyMap<string, { meta: StepEmissionScopeMeta; closed: boolean }>;
  batch: {
    outgoingByScope: ReadonlyMap<string, readonly TOutEmission[]>;
  };
}): Promise<
  BufferedFlushResult<WorkflowStepEmission<TOutEmission>, WorkflowStepEvent<TInEvent>>
> => {
  const instanceRef = buildScopedInstanceRowId(options.workflowName, options.instanceId);
  const result = await options
    .handlerTx()
    .retrieve(({ forSchema }) => {
      const uow = forSchema(workflowsSchema);
      return uow
        .findFirst("workflow_instance", (b) =>
          b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb.and(
              eb("workflowName", "=", options.workflowName),
              eb("instanceId", "=", options.instanceId),
            ),
          ),
        )
        .find("workflow_step_emission", (b) =>
          b
            .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
              eb("instanceRef", "=", instanceRef),
            )
            .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", "asc"),
        )
        .find("workflow_event", (b) =>
          b
            .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
              eb("instanceRef", "=", instanceRef),
            )
            .orderByIndex("idx_workflow_event_instanceRef_createdAt", "asc"),
        );
    })
    .mutate(({ forSchema, retrieveResult: [instance, rows, events] }) => {
      if (!instance) {
        throw new Error("INSTANCE_NOT_FOUND");
      }

      const uow = forSchema(workflowsSchema);
      const retrievedRows: LogicalStepEmissionRow[] = rows.map((row) => ({
        id: row.id.toString(),
        actor: row.actor,
        stepKey: row.stepKey,
        epoch: row.epoch,
        sequence: row.sequence,
        payload: row.payload,
        createdAt: row.createdAt,
      }));
      const createdRows: LogicalStepEmissionRow[] = [];
      let nextSequence = 0;
      const appendRow = (row: {
        stepKey: string;
        epoch: string;
        sequence: number;
        actor: typeof WORKFLOW_EVENT_ACTOR_SYSTEM | typeof WORKFLOW_EVENT_ACTOR_USER;
        payload: unknown;
      }) => {
        const createdAt = new Date();
        const id = uow.create("workflow_step_emission", {
          instanceRef: instance.id,
          stepKey: row.stepKey,
          epoch: row.epoch,
          sequence: row.sequence,
          actor: row.actor,
          payload: row.payload,
          createdAt,
        });
        createdRows.push({ ...row, createdAt, id: id.toString() });
      };

      for (const [stepKey, scope] of options.scopes) {
        if (scope.closed) {
          continue;
        }
        const step = scope.meta;
        const existingRows = retrievedRows.filter(
          (row) => row.stepKey === stepKey && row.epoch === step.epoch,
        );
        if (!existingRows.some((row) => row.actor === WORKFLOW_EVENT_ACTOR_SYSTEM)) {
          appendRow({
            stepKey,
            epoch: step.epoch,
            sequence: nextSequence++,
            actor: WORKFLOW_EVENT_ACTOR_SYSTEM,
            payload: STEP_STARTED_PAYLOAD,
          });
        }

        for (const payload of options.batch.outgoingByScope.get(stepKey) ?? []) {
          appendRow({
            stepKey,
            epoch: step.epoch,
            sequence: nextSequence++,
            actor: WORKFLOW_EVENT_ACTOR_USER,
            payload,
          });
        }
      }

      return { retrievedRows, createdRows, events };
    })
    .execute();

  const observedItems = [...result.retrievedRows, ...result.createdRows].map((row) => ({
    id: row.id,
    actor: row.actor,
    stepKey: row.stepKey,
    epoch: row.epoch,
    sequence: row.sequence,
    payload: trustStoredStepEmissionPayload<TOutEmission>(row.payload),
    createdAt: row.createdAt,
  }));

  const queuedConsumptionPredicates = [...options.scopes.values()].map(
    (scope) => scope.meta.isEventConsumptionQueued,
  );
  const pendingEvents = [...result.events]
    .filter(
      (event) =>
        !isSystemEventActor(event.actor) &&
        !event.consumedByStepKey &&
        !queuedConsumptionPredicates.some((isQueued) => isQueued(event)),
    )
    .sort((a, b) => {
      const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
      return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
    });

  return {
    observedItems,
    scopeDeliveries: [...options.scopes.values()].flatMap((scope) => {
      if (scope.closed || scope.meta.eventTypeCounts.size === 0) {
        return [];
      }
      return pendingEvents
        .filter((event) => scope.meta.eventTypeCounts.has(event.type))
        .map((event) => ({
          scopeKey: scope.meta.stepKey,
          message: buildWorkflowStepEvent<TInEvent>(event, scope.meta),
          cursor: event.id.toString(),
        }));
    }),
  };
};

// DB json columns are typed as unknown by @fragno-dev/db. Workflow-specific
// code supplies TOutEmission/TInEvent at the pump boundary; payload validation
// before enqueue/persist is intentionally deferred.
const trustStoredStepEmissionPayload = <TEmission>(payload: unknown): TEmission =>
  payload as TEmission;

const buildWorkflowStepEvent = <TPayload>(
  event: WorkflowEventRecord,
  scope: StepEmissionScopeMeta,
): WorkflowStepEvent<TPayload> => ({
  id: event.id.toString(),
  type: event.type,
  payload: (event.payload ?? null) as Readonly<TPayload>,
  timestamp: event.createdAt,
  consume: () => scope.queueEventConsumption(event, scope.stepKey),
});
