import { copyJson, type Context } from "@earendil-works/chord";
import {
  defineDoc,
  type JsonObject,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type DocumentReader,
  type Harness,
  type SettledSubmissionRecord,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";

import type { PiAgentTurn } from "./pi-agent-contract";
import { forgetRunningPiSubagent, piSubagentConversation } from "./pi-agent-subagents";

// Turns are stored as JSON; this module writes every value, so reads cast them back.
type PiAgentTurnsState = {
  /**
   * Turns by prompt request id, the root's and its subagents', until their settlement has been
   * reported. Pi settles submissions in its own commits, so a settled turn stays here as the
   * outbox of its turn event.
   */
  pending: { [requestId: string]: JsonObject };
  /** Authority for the root's work outside any run, such as compaction after its last turn. */
  latest: JsonObject | null;
};

function storedTurn(turn: PiAgentTurn): JsonObject {
  return copyJson(turn) as JsonObject;
}

const PiAgentTurnsDoc = defineDoc<PiAgentTurnsState>({
  kind: "backoffice.pi.turns",
  version: 1,
  scope: "session",
  // Each turn adds and settles its record; a base every 32 changes keeps reopening cheap.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
  initial: () => ({ pending: {}, latest: null }),
});

/**
 * Records a turn before its prompt is admitted to `conversationId`, the root or a subagent's, so
 * no generation or tool can start without it. A retried admission keeps the authority of the
 * submission it deduplicates to.
 */
export async function recordPiAgentTurn(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
  turn: PiAgentTurn,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const turns = await tx.doc(PiAgentTurnsDoc);
    if (!(await tx.submissionByRequest(conversationId, requestId))) {
      turns.pending[requestId] = storedTurn(turn);
    }
  }, context);
}

/**
 * A recorded turn Pi has started or settled, whose events may not all be reported yet. Pi gives an
 * input the entry it places it as when it starts on it, and keeps it once it settles.
 */
export type ReportablePiAgentTurn = {
  requestId: string;
  /** The root's, or a subagent's. */
  conversationId: ConversationId;
  turn: PiAgentTurn;
  started: boolean;
  /** Null while the turn runs. */
  settlement: SettledSubmissionRecord | null;
};

export async function readReportablePiAgentTurns(
  read: DocumentReader,
  storage: Pick<Storage, "submissionByRequest">,
  context: Context,
): Promise<ReportablePiAgentTurn[]> {
  const turns = await read.snapshot(PiAgentTurnsDoc, context);
  const reportable: ReportablePiAgentTurn[] = [];
  for (const [requestId, turn] of Object.entries(turns?.pending ?? {})) {
    const conversationId =
      (await piSubagentConversation(read, requestId, context)) ?? ROOT_CONVERSATION_ID;
    const submission = await storage.submissionByRequest(conversationId, requestId, context);
    if (!submission) {
      continue;
    }
    const started = submission.type === "input" && submission.entry !== undefined;
    const settlement =
      submission.status === "done" || submission.status === "unanswered" ? submission : null;
    if (started || settlement) {
      reportable.push({
        requestId,
        conversationId,
        turn: turn as unknown as PiAgentTurn,
        started,
        settlement,
      });
    }
  }
  return reportable;
}

/**
 * Forgets a settled turn once its turn event is recorded, and that its subagent may run; running
 * turns keep their authority.
 */
export async function forgetReportedPiAgentTurn(
  harness: Harness,
  requestId: string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    delete (await tx.doc(PiAgentTurnsDoc)).pending[requestId];
    await forgetRunningPiSubagent(tx, requestId);
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
  conversationId: ConversationId,
  requestId: string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const turns = await tx.doc(PiAgentTurnsDoc);
    if (!(await tx.submissionByRequest(conversationId, requestId))) {
      delete turns.pending[requestId];
    }
  }, context);
}

type PiQueuedCompactionsState = {
  /** Pi's compaction task of each compaction the queue dispatched, until its settlement is reported. */
  pending: { [requestId: string]: number };
  /**
   * The newest compaction started, and the queue revision of the handover that started it. The
   * queue dispatches a compaction only once the one before it settled, at a later revision, so a
   * handover of it again, or one older than it, is obsolete.
   */
  latest: { requestId: string; revision: number } | null;
};

const PiQueuedCompactionsDoc = defineDoc<PiQueuedCompactionsState>({
  kind: "backoffice.pi.queued-compactions",
  version: 1,
  scope: "session",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
  initial: () => ({ pending: {}, latest: null }),
});

/**
 * Whether a handover of the queue's compaction `requestId` at queue `revision` comes too late: that
 * compaction already started, or a newer one did.
 */
export async function isObsoleteQueuedPiCompaction(
  read: DocumentReader,
  requestId: string,
  revision: number,
  context: Context,
): Promise<boolean> {
  const latest = (await read.snapshot(PiQueuedCompactionsDoc, context))?.latest ?? null;
  return latest !== null && (latest.requestId === requestId || revision < latest.revision);
}

/**
 * Records Pi's compaction task for the queue's compaction `requestId`, handed over at queue
 * `revision`, until it is reported.
 */
export async function recordQueuedPiCompaction(
  harness: Harness,
  requestId: string,
  revision: number,
  taskId: number,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const compactions = await tx.doc(PiQueuedCompactionsDoc);
    compactions.pending[requestId] = taskId;
    compactions.latest = { requestId, revision };
  }, context);
}

/** The queue's compactions whose Pi task ended, by request ID, which the queue waits to hear of. */
export async function readSettledQueuedPiCompactions(
  harness: Harness,
  context: Context,
): Promise<string[]> {
  const compactions = await harness.snapshot(PiQueuedCompactionsDoc, context);
  const settled: string[] = [];
  for (const [requestId, taskId] of Object.entries(compactions?.pending ?? {})) {
    const task = await harness.getTask(taskId as TaskId, context);
    // A missing task cannot run any more, so it ended too.
    if (task === undefined || task.state.status === "terminal") {
      settled.push(requestId);
    }
  }
  return settled;
}

export async function forgetReportedQueuedPiCompaction(
  harness: Harness,
  requestId: string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    delete (await tx.doc(PiQueuedCompactionsDoc)).pending[requestId];
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

/** A running run whose turn record is missing has no authority, which fails closed. */
export type PiAgentRun = { type: "idle" } | { type: "running"; turn: PiAgentTurn | null };

/** The current run of `conversationId`: the root's, or a subagent's. */
export async function readPiAgentRun(
  read: DocumentReader,
  storage: Pick<Storage, "submission">,
  conversationId: ConversationId,
  context: Context,
): Promise<PiAgentRun> {
  const [turns, live] = await Promise.all([
    read.snapshot(PiAgentTurnsDoc, context),
    read.snapshot(LiveDoc, conversationId, context),
  ]);
  const input = live?.run?.inputs[0];
  if (input === undefined) {
    return { type: "idle" };
  }
  const requestId = (await storage.submission(input, context))?.requestId;
  return {
    type: "running",
    turn:
      requestId === undefined ? null : ((turns?.pending[requestId] ?? null) as PiAgentTurn | null),
  };
}

/**
 * Returns the turn that owns work in `conversationId`. Every conversation runs one turn at a
 * time, so its current run owns its work. Outside any run, the latest admitted turn owns the
 * root's, such as background compaction; a subagent does no work of its own once it answered.
 */
export async function readActivePiAgentTurn(
  read: DocumentReader,
  storage: Pick<Storage, "submission">,
  conversationId: ConversationId,
  context: Context,
): Promise<PiAgentTurn | null> {
  const run = await readPiAgentRun(read, storage, conversationId, context);
  if (run.type === "running") {
    return run.turn;
  }
  if (conversationId !== ROOT_CONVERSATION_ID) {
    return null;
  }
  const turns = await read.snapshot(PiAgentTurnsDoc, context);
  return (turns?.latest ?? null) as PiAgentTurn | null;
}
