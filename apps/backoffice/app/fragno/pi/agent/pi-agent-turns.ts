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
} from "@earendil-works/pi-durable";

import type { PiAgentTurn } from "./pi-agent-contract";

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

/**
 * A recorded turn Pi has started or settled, whose events may not all be reported yet. Pi gives an
 * input the entry it places it as when it starts on it, and keeps it once it settles.
 */
export type ReportablePiAgentTurn = {
  requestId: string;
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
    const submission = await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, context);
    if (!submission) {
      continue;
    }
    const started = submission.type === "input" && submission.entry !== undefined;
    const settlement =
      submission.status === "done" || submission.status === "unanswered" ? submission : null;
    if (started || settlement) {
      reportable.push({ requestId, turn: turn as unknown as PiAgentTurn, started, settlement });
    }
  }
  return reportable;
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
