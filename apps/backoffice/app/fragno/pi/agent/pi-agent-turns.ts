import { awaitWithContext } from "@earendil-works/chord/context";

import { copyJson, type Context } from "@earendil-works/chord";
import {
  defineDoc,
  type JsonObject,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type DocumentReader,
  type Harness,
  type SettledSubmissionRecord,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";

import type { PiAgentTurn } from "./pi-agent-contract";
import type { PiNotificationReference } from "./pi-agent-notification-entry";

// Turns are stored as JSON; this module writes every value, so reads cast them back.
type PiAgentTurnsState = {
  /**
   * Turns by prompt request id, until their settlement has been reported. Pi settles submissions
   * in its own commits, so a settled turn stays here as the outbox of its turn event.
   */
  pending: { [requestId: string]: JsonObject };
  /** Authority for work outside any run, such as compaction after the last turn ended. */
  latest: JsonObject | null;
};

function storedTurn(turn: PiAgentTurn): JsonObject {
  return copyJson(turn) as JsonObject;
}

const PiAgentTurnsDoc = defineDoc<PiAgentTurnsState>({
  kind: "backoffice.pi.turns",
  version: 1,
  scope: "session",
  initial: () => ({ pending: {}, latest: null }),
});

/**
 * Records a turn before its prompt is admitted, so no generation or tool can start without it.
 * A retried admission keeps the authority of the submission it deduplicates to.
 */
export async function recordPiAgentTurn(
  harness: Harness,
  requestId: string,
  turn: PiAgentTurn,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const turns = await tx.doc(PiAgentTurnsDoc);
    if (!(await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId))) {
      turns.pending[requestId] = storedTurn(turn);
    }
  }, context);
}

/** A recorded turn whose submission Pi has settled but whose settlement is not yet reported. */
export type SettledPiAgentTurn = {
  requestId: string;
  turn: PiAgentTurn;
  submission: SettledSubmissionRecord;
};

export async function readSettledPiAgentTurns(
  read: DocumentReader,
  storage: Pick<Storage, "submissionByRequest">,
  context: Context,
): Promise<SettledPiAgentTurn[]> {
  const turns = await read.snapshot(PiAgentTurnsDoc, context);
  const settled: SettledPiAgentTurn[] = [];
  for (const [requestId, turn] of Object.entries(turns?.pending ?? {})) {
    const submission = await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, context);
    if (submission?.status === "done" || submission?.status === "unanswered") {
      settled.push({ requestId, turn: turn as unknown as PiAgentTurn, submission });
    }
  }
  return settled;
}

/** Forgets a settled turn once its turn event is recorded; running turns keep their authority. */
export async function forgetReportedPiAgentTurn(
  harness: Harness,
  requestId: string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    delete (await tx.doc(PiAgentTurnsDoc)).pending[requestId];
  }, context);
}

/**
 * Makes an admitted turn the authority for work outside any run. Only admitted turns qualify, so a
 * rejected prompt never decides who background compaction runs as.
 */
export async function recordAdmittedPiAgentTurn(
  harness: Harness,
  turn: PiAgentTurn,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    (await tx.doc(PiAgentTurnsDoc)).latest = storedTurn(turn);
  }, context);
}

/** Forgets a recorded turn whose prompt Pi did not admit; an admitted submission keeps its turn. */
export async function withdrawPiAgentTurn(
  harness: Harness,
  requestId: string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const turns = await tx.doc(PiAgentTurnsDoc);
    if (!(await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId))) {
      delete turns.pending[requestId];
    }
  }, context);
}

/** Manual compaction runs outside a turn, as whoever requested it. */
export async function recordPiAgentCompactionTurn(
  harness: Harness,
  turn: PiAgentTurn,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    (await tx.doc(PiAgentTurnsDoc)).latest = storedTurn(turn);
  }, context);
}

/** A follow-up this agent posted, by request ID, and the notifications it asks the agent for. */
type PiAgentNotificationFollowUp = { requestId: string; notifications: PiNotificationReference[] };

// Follow-ups that may still be queued; ones Pi placed, withdrew, or never received are pruned.
type PiAgentNotificationsState = { followUps: PiAgentNotificationFollowUp[] };

const PiAgentNotificationsDoc = defineDoc<PiAgentNotificationsState>({
  kind: "backoffice.pi.notifications",
  version: 1,
  scope: "session",
  initial: () => ({ followUps: [] }),
});

/** A posted follow-up still in the inbox, with the turn it will run as. */
export type QueuedPiAgentNotificationFollowUp = PiAgentNotificationFollowUp & {
  submissionId: SubmissionId;
  turn: PiAgentTurn;
};

export async function readQueuedPiAgentNotificationFollowUps(
  read: DocumentReader,
  storage: Pick<Storage, "submissionByRequest">,
  context: Context,
): Promise<QueuedPiAgentNotificationFollowUp[]> {
  const [notifications, turns] = await Promise.all([
    read.snapshot(PiAgentNotificationsDoc, context),
    read.snapshot(PiAgentTurnsDoc, context),
  ]);
  const queued: QueuedPiAgentNotificationFollowUp[] = [];
  for (const followUp of notifications?.followUps ?? []) {
    const submission = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      followUp.requestId,
      context,
    );
    const turn = turns?.pending[followUp.requestId] as PiAgentTurn | undefined;
    if (submission?.status === "queued" && turn) {
      queued.push({
        requestId: followUp.requestId,
        notifications: [...followUp.notifications],
        submissionId: submission.id,
        turn,
      });
    }
  }
  return queued;
}

/** Records a follow-up before it is submitted, so a restart between the two still finds it. */
export async function recordPiAgentNotificationFollowUp(
  harness: Harness,
  followUp: PiAgentNotificationFollowUp,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const notifications = await tx.doc(PiAgentNotificationsDoc);
    const queued = [];
    for (const recorded of notifications.followUps) {
      if (
        recorded.requestId !== followUp.requestId &&
        (await tx.submissionByRequest(ROOT_CONVERSATION_ID, recorded.requestId))?.status ===
          "queued"
      ) {
        queued.push(recorded);
      }
    }
    notifications.followUps = [...queued, followUp];
  }, context);
}

/** Resolves with the root conversation's submission for the request once there is one. */
export async function waitForPiAgentSubmission(
  harness: Harness,
  storage: Pick<Storage, "submissionByRequest">,
  requestId: string,
  context: Context,
): Promise<SubmissionRecord> {
  let unsubscribe = () => {};
  const submitted = new Promise<SubmissionRecord>((resolve) => {
    unsubscribe = harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (
          change.type === "submission" &&
          change.value.conversationId === ROOT_CONVERSATION_ID &&
          change.value.requestId === requestId
        ) {
          resolve(change.value);
        }
      }
    });
  });
  try {
    // Subscribing before reading catches a submission committed while the read runs.
    return (
      (await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, context)) ??
      (await awaitWithContext(submitted, context))
    );
  } finally {
    unsubscribe();
  }
}

/** A running root run whose turn record is missing has no authority, which fails closed. */
export type PiAgentRun = { type: "idle" } | { type: "running"; turn: PiAgentTurn | null };

/** The root conversation's current run, which owns every turn-scoped piece of agent work. */
export async function readPiAgentRun(
  read: DocumentReader,
  storage: Pick<Storage, "submission">,
  context: Context,
): Promise<PiAgentRun> {
  const [turns, live] = await Promise.all([
    read.snapshot(PiAgentTurnsDoc, context),
    read.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context),
  ]);
  const owner = live?.run?.inputs[0];
  if (owner === undefined) {
    return { type: "idle" };
  }
  const requestId = (await storage.submission(owner, context))?.requestId;
  return {
    type: "running",
    turn:
      requestId === undefined ? null : ((turns?.pending[requestId] ?? null) as PiAgentTurn | null),
  };
}

/**
 * Returns the turn that owns the agent's current work. The root conversation is the agent's only
 * conversation and runs one turn at a time, so its current run owns everything; outside any run,
 * the latest admitted turn does.
 */
export async function readActivePiAgentTurn(
  read: DocumentReader,
  storage: Pick<Storage, "submission">,
  context: Context,
): Promise<PiAgentTurn | null> {
  const run = await readPiAgentRun(read, storage, context);
  if (run.type === "running") {
    return run.turn;
  }
  const turns = await read.snapshot(PiAgentTurnsDoc, context);
  return (turns?.latest ?? null) as PiAgentTurn | null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)),
        )
      : nested,
  );
}

/** Steering joins the running turn, so only a submission with that turn's authority may steer. */
export function mayJoinPiAgentTurn(running: PiAgentTurn, joining: PiAgentTurn): boolean {
  return (
    canonicalJson([running.actors, running.scopeRestriction]) ===
    canonicalJson([joining.actors, joining.scopeRestriction])
  );
}
