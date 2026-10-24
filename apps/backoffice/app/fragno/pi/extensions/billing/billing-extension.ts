import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  defineTask,
  type ConversationId,
  type Extension,
  type Harness,
  type Task,
  type TaskId,
} from "@earendil-works/pi-durable";

import type { BillingEventInput, BillingRecordEventResult } from "@/fragno/billing/contracts";

import {
  createPiDurableBillingEvent,
  hasPiBillingUsage,
  piBillingCountersFromUsage,
  subtractPiBillingCounters,
  type PiBillingCounters,
} from "./usage-counters";

type PiDurableBillingState = {
  delivered: PiBillingCounters;
  conversationId: number | null;
  activeTaskId: number | null;
};

type PiDurableBillingTaskInput = {
  through: PiBillingCounters;
  occurredAt: string;
};

type PiDurableBillingTaskCheckpoint = {
  /** Old tasks keep their original destination even when a delivery's acknowledgement was lost. */
  attribution: "owner" | "legacy";
} & (
  | {
      phase: "prepare";
      through: PiBillingCounters;
      occurredAt: string;
    }
  | {
      phase: "deliver";
      through: PiBillingCounters;
      event: BillingEventInput;
      attempt: number;
      retryAtEpochMs: number;
    }
);
type PiDurableBillingTaskResult = {
  eventId: string | null;
  accepted: boolean;
};

export const PiDurableBillingDoc = defineDoc<PiDurableBillingState>({
  kind: "backoffice.pi.billing",
  version: 1,
  scope: "session",
  // A few counters, so every change stores the whole document.
  checkpointWhen: () => true,
  initial: () => ({
    delivered: piBillingCountersFromUsage([]),
    conversationId: null,
    activeTaskId: null,
  }),
});

/** Returns the bounded exponential delay before a durable Pi billing retry. */
export function calculatePiDurableBillingRetryDelayMs(attempt: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

async function durableBillingEventId(config: PiAgentConfig, taskId: number) {
  const source = JSON.stringify(["agent", config.scope, config.agentName]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const agentHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `pi-durable:${agentHash}:${taskId}`;
}

/** Creates the durable task whose checkpoint is the exact idempotent Billing RPC outbox event. */
function createPiDurableBillingTask(input: {
  config: PiAgentConfig;
  recordEvent: (event: BillingEventInput) => Promise<BillingRecordEventResult>;
  recordLegacyEvent: (event: BillingEventInput) => Promise<BillingRecordEventResult>;
  retryDelayMs: (attempt: number) => number;
}): Task<
  PiDurableBillingTaskInput,
  PiDurableBillingTaskCheckpoint,
  PiDurableBillingTaskResult,
  object
> {
  const { config, recordEvent, recordLegacyEvent, retryDelayMs } = input;

  return defineTask<
    PiDurableBillingTaskInput,
    PiDurableBillingTaskCheckpoint,
    PiDurableBillingTaskResult
  >({
    name: "backoffice.pi.billing-delivery",
    version: 1,
    initial: (taskInput: PiDurableBillingTaskInput) => ({
      attribution: "owner" as const,
      phase: "prepare" as const,
      through: taskInput.through,
      occurredAt: taskInput.occurredAt,
    }),
    phases: {
      prepare: async (task, runtime, context) => {
        const eventId = await durableBillingEventId(config, task.id);
        await runtime.commit(async (tx) => {
          const billing = await tx.doc(PiDurableBillingDoc);
          if (billing.activeTaskId !== task.id) {
            throw new Error(
              `PI_DURABLE_BILLING_TASK_OWNERSHIP_MISMATCH:${task.id}:${billing.activeTaskId}`,
            );
          }

          const delta = subtractPiBillingCounters(task.state.checkpoint.through, billing.delivered);
          if (!hasPiBillingUsage(delta)) {
            billing.activeTaskId = null;
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: { eventId: null, accepted: false },
              },
            };
          }

          return {
            status: "running",
            checkpoint: {
              // The stored task boundary is the only place that accepts the previous checkpoint shape.
              attribution:
                "attribution" in task.state.checkpoint
                  ? task.state.checkpoint.attribution
                  : "legacy",
              phase: "deliver",
              through: task.state.checkpoint.through,
              event: createPiDurableBillingEvent({
                eventId,
                scope: config.scope,
                agentName: config.agentName,
                taskId: task.id,
                occurredAt: task.state.checkpoint.occurredAt,
                through: task.state.checkpoint.through,
                delta,
              }),
              attempt: 0,
              retryAtEpochMs: runtime.now(),
            },
          };
        }, context);
      },
      deliver: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        // Retries sleep until their time; a delivery stored before sleeps existed waited here.
        if (checkpoint.retryAtEpochMs > runtime.now()) {
          await runtime.sleepUntil(checkpoint.retryAtEpochMs, checkpoint, context);
          return;
        }

        let result: BillingRecordEventResult;
        try {
          result = await ("attribution" in checkpoint && checkpoint.attribution === "owner"
            ? recordEvent(checkpoint.event)
            : recordLegacyEvent(checkpoint.event));
        } catch (error) {
          runtime.report(error);
          const retryAtEpochMs = runtime.now() + retryDelayMs(checkpoint.attempt);
          await runtime.sleepUntil(
            retryAtEpochMs,
            { ...checkpoint, attempt: checkpoint.attempt + 1, retryAtEpochMs },
            context,
          );
          return;
        }

        if (result.eventId !== checkpoint.event.id) {
          throw new Error(
            `PI_DURABLE_BILLING_EVENT_ID_MISMATCH:${checkpoint.event.id}:${result.eventId}`,
          );
        }

        await runtime.commit(async (tx) => {
          const billing = await tx.doc(PiDurableBillingDoc);
          if (billing.activeTaskId !== task.id) {
            throw new Error(
              `PI_DURABLE_BILLING_TASK_OWNERSHIP_MISMATCH:${task.id}:${billing.activeTaskId}`,
            );
          }
          billing.delivered = checkpoint.through;
          billing.activeTaskId = null;
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: { eventId: checkpoint.event.id, accepted: result.accepted },
            },
          };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const billing = await tx.doc(PiDurableBillingDoc);
        if (billing.activeTaskId === task.id) {
          billing.activeTaskId = null;
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
}

type PiDurableBillingTask = ReturnType<typeof createPiDurableBillingTask>;

async function ensurePiDurableBillingTask(input: {
  harness: Harness;
  task: PiDurableBillingTask;
  nowEpochMs: number;
  context: Context;
}): Promise<TaskId<PiDurableBillingTaskResult> | null> {
  const { harness, task, nowEpochMs, context } = input;
  const usage = await harness.usage(context);
  const through = piBillingCountersFromUsage(Object.values(usage.models));

  return await harness.commit(async (tx) => {
    const billing = await tx.doc(PiDurableBillingDoc);
    if (billing.activeTaskId !== null) {
      const activeTaskId = billing.activeTaskId as TaskId<PiDurableBillingTaskResult>;
      const activeTask = await tx.task(activeTaskId);
      if (activeTask && activeTask.state.status !== "terminal") {
        return activeTaskId;
      }
      billing.activeTaskId = null;
    }

    const delta = subtractPiBillingCounters(through, billing.delivered);
    if (!hasPiBillingUsage(delta)) {
      return null;
    }

    let conversationId = billing.conversationId as ConversationId | null;
    if (conversationId === null) {
      conversationId = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      billing.conversationId = conversationId;
    }
    const taskId = await tx.createTask(
      task,
      { through, occurredAt: new Date(nowEpochMs).toISOString() },
      {
        ownership: { kind: "conversation" },
        conversationId,
        background: true,
      },
    );
    billing.activeTaskId = taskId;
    return taskId;
  }, context);
}

/** Throws for a delivery task that ended without delivering, so the wakeup that ran it fails. */
async function assertPiDurableBillingTaskNotFailed(
  harness: Harness,
  taskId: TaskId<PiDurableBillingTaskResult>,
  context: Context,
): Promise<void> {
  const task = await harness.getTask(taskId, context);
  if (task?.state.status !== "terminal") {
    return;
  }
  const { status } = task.state.outcome;
  if (status === "failed" || status === "faulted" || status === "orphaned") {
    throw new Error(`PI_DURABLE_BILLING_TASK_FAILED:${taskId}:${status}`);
  }
}

/** Delivers committed model usage to an agent's root owner through a background durable task. */
export type PiBilling = {
  extension: Extension;
  /** Atomically repairs the billing watermark and admits at most one delivery task. */
  ensure(
    harness: Harness,
    nowEpochMs: number,
    context: Context,
  ): Promise<TaskId<PiDurableBillingTaskResult> | null>;
  /** Throws when a delivery task `ensure` returned ended without delivering. */
  assertNotFailed(
    harness: Harness,
    taskId: TaskId<PiDurableBillingTaskResult>,
    context: Context,
  ): Promise<void>;
};

export function createPiBilling(input: {
  config: PiAgentConfig;
  recordEvent: (event: BillingEventInput) => Promise<BillingRecordEventResult>;
  recordLegacyEvent: (event: BillingEventInput) => Promise<BillingRecordEventResult>;
  retryDelayMs: (attempt: number) => number;
}): PiBilling {
  const task = createPiDurableBillingTask(input);
  return {
    extension: defineExtension({ name: "backoffice.billing", tasks: [task] }),
    ensure: async (harness, nowEpochMs, context) =>
      await ensurePiDurableBillingTask({ harness, task, nowEpochMs, context }),
    assertNotFailed: assertPiDurableBillingTaskNotFailed,
  };
}
