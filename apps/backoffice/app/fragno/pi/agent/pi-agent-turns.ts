import { copyJson, type Context } from "@earendil-works/chord";
import {
  defineDoc,
  type JsonObject,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type DocumentReader,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";

import type { PiAgentTurn } from "./pi-agent-contract";

// Turns are stored as JSON; this module writes every value, so reads cast them back.
type PiAgentTurnsState = {
  /** Turns whose root-conversation submissions have not settled, by prompt request id. */
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
    for (const pendingRequestId of Object.keys(turns.pending)) {
      const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, pendingRequestId);
      if (submission?.status === "done" || submission?.status === "unanswered") {
        delete turns.pending[pendingRequestId];
      }
    }
    if (!(await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId))) {
      turns.pending[requestId] = storedTurn(turn);
    }
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
