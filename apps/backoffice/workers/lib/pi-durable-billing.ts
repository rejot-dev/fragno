import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  type ConversationId,
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
} from "@/fragno/billing/pi";
import type { PiAgentConfig } from "@/fragno/pi-manager/pi-agent-contract";

type PiDurableBillingState = {
  delivered: PiBillingCounters;
  conversationId: number | null;
  activeTaskId: number | null;
};

type PiDurableBillingTaskInput = {
  through: PiBillingCounters;
  occurredAt: string;
};

type PiDurableBillingTaskCheckpoint =
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
    };

type PiDurableBillingTaskResult = {
  eventId: string | null;
  accepted: boolean;
};

export const PiDurableBillingDoc = defineDoc<PiDurableBillingState>({
  kind: "backoffice.pi.billing",
  version: 1,
  scope: "session",
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
  const source = JSON.stringify([config.scope, config.sessionId]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const sessionHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `pi-durable:${sessionHash}:${taskId}`;
}

/** Creates the durable task whose checkpoint is the exact idempotent Billing RPC outbox event. */
export function createPiDurableBillingTask(input: {
  config: PiAgentConfig;
  recordEvent: (event: BillingEventInput) => Promise<BillingRecordEventResult>;
  retryDelayMs: (attempt: number) => number;
}): Task<
  PiDurableBillingTaskInput,
  PiDurableBillingTaskCheckpoint,
  PiDurableBillingTaskResult,
  object
> {
  const { config, recordEvent, retryDelayMs } = input;

  return defineTask<
    PiDurableBillingTaskInput,
    PiDurableBillingTaskCheckpoint,
    PiDurableBillingTaskResult
  >({
    name: "backoffice.pi.billing-delivery",
    version: 1,
    initial: (taskInput: PiDurableBillingTaskInput) => ({
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
              phase: "deliver",
              through: task.state.checkpoint.through,
              event: createPiDurableBillingEvent({
                eventId,
                scope: config.scope,
                sessionId: config.sessionId,
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
        if (checkpoint.retryAtEpochMs > runtime.now()) {
          await runtime.sleep(checkpoint.retryAtEpochMs, context);
        }

        let result: BillingRecordEventResult;
        try {
          result = await recordEvent(checkpoint.event);
        } catch (error) {
          runtime.report(error);
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                ...checkpoint,
                attempt: checkpoint.attempt + 1,
                retryAtEpochMs: runtime.now() + retryDelayMs(checkpoint.attempt),
              },
            }),
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

export type PiDurableBillingTask = ReturnType<typeof createPiDurableBillingTask>;

/** Atomically repairs the billing watermark and admits at most one delivery task. */
export async function ensurePiDurableBillingTask(input: {
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

/** Runs billing delivery through the current committed usage watermark. */
export async function flushPiDurableBilling(input: {
  harness: Harness;
  task: PiDurableBillingTask;
  nowEpochMs: () => number;
  context: Context;
}): Promise<void> {
  const { harness, task, nowEpochMs, context } = input;

  while (true) {
    const taskId = await ensurePiDurableBillingTask({
      harness,
      task,
      nowEpochMs: nowEpochMs(),
      context,
    });
    if (taskId === null) {
      return;
    }

    harness.resume();
    const settled = await harness.waitForTask(taskId, context);
    if (
      settled.state.outcome.status === "failed" ||
      settled.state.outcome.status === "faulted" ||
      settled.state.outcome.status === "orphaned"
    ) {
      throw new Error(`PI_DURABLE_BILLING_TASK_FAILED:${taskId}:${settled.state.outcome.status}`);
    }
  }
}
