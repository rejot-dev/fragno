import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineDocFamily,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type DocumentObserver,
  type DocumentReader,
  type DocumentWatch,
  type Tx,
} from "@earendil-works/pi-durable";

/**
 * Where a subagent stands, as its agent knows it: waiting in the queue for a slot, starting in its
 * conversation, started once its prompt is submitted there, or dropped before it started.
 */
export type PiSubagentState =
  | { status: "waiting" }
  | { status: "starting"; conversationId: number }
  | { status: "started"; conversationId: number }
  | { status: "dropped"; reason: string };

/**
 * A subagent of the agent, by the request ID that asked for it, from when the queue takes it. It
 * stays after the subagent ends, so its submission and transcript stay readable by that request
 * ID, and those waiting for it can watch it before it starts.
 */
const PiSubagentDoc = defineDocFamily<PiSubagentState, PiSubagentState>({
  kind: "backoffice.pi.subagent",
  version: 2,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  // Version 1 recorded only started subagents, by their conversation.
  migrate: (value) => ({ status: "started", conversationId: value.conversationId as number }),
  checkpointWhen: () => true,
});

/**
 * Subagents whose work may still run, by request ID, so a stop and the model boundary find their
 * conversations without scanning every subagent the agent ever ran.
 */
const PiRunningSubagentsDoc = defineDoc<{ running: { [requestId: string]: number } }>({
  kind: "backoffice.pi.subagents.running",
  version: 1,
  scope: "session",
  initial: () => ({ running: {} }),
  // Each subagent adds and removes its entry; a base every 32 changes keeps reopening cheap.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/** Another conversation already runs the subagent a request ID started. */
export class PiSubagentStartedError extends Error {
  constructor(requestId: string) {
    super(`Request ${requestId} already started a subagent.`);
    this.name = "PiSubagentStartedError";
  }
}

/** Records that the queue holds a subagent until a slot frees; one it already started stays. */
export async function recordWaitingPiSubagent(tx: Tx, requestId: string): Promise<void> {
  await tx.doc(PiSubagentDoc, requestId, { status: "waiting" });
}

/** Records that the queue dropped a subagent that waited; one it already started stays. */
export async function recordDroppedPiSubagent(
  tx: Tx,
  requestId: string,
  reason: string,
): Promise<void> {
  const recorded = await tx.doc(PiSubagentDoc, requestId, { status: "dropped", reason });
  if (recorded.status === "waiting") {
    replaceState(recorded, { status: "dropped", reason });
  }
}

/**
 * Records a subagent's conversation, in the commit that creates it. Throws, failing that commit,
 * when the request ID already started another, so one request never runs twice.
 */
export async function recordPiSubagent(
  tx: Tx,
  requestId: string,
  conversationId: ConversationId,
): Promise<void> {
  const recorded = await tx.doc(PiSubagentDoc, requestId, {
    status: "starting",
    conversationId,
  });
  if (
    (recorded.status === "starting" || recorded.status === "started") &&
    recorded.conversationId !== conversationId
  ) {
    throw new PiSubagentStartedError(requestId);
  }
  if (recorded.status === "waiting" || recorded.status === "dropped") {
    replaceState(recorded, { status: "starting", conversationId });
  }
  (await tx.doc(PiRunningSubagentsDoc)).running[requestId] = conversationId;
}

/**
 * Records that a subagent's prompt is submitted in its conversation, so whoever waits for it
 * finds its submission there.
 */
export async function recordStartedPiSubagent(tx: Tx, requestId: string): Promise<void> {
  const recorded = await tx.doc(PiSubagentDoc, requestId, { status: "waiting" });
  if (recorded.status === "started") {
    return;
  }
  if (recorded.status !== "starting") {
    throw new Error(`Subagent ${requestId} is ${recorded.status}, not starting.`);
  }
  replaceState(recorded, { status: "started", conversationId: recorded.conversationId });
}

// A tracked document changes in place, so a state of another shape replaces its fields.
function replaceState(recorded: PiSubagentState, state: PiSubagentState) {
  for (const key of Object.keys(recorded)) {
    delete (recorded as Record<string, unknown>)[key];
  }
  Object.assign(recorded, state);
}

/** Forgets that a subagent may run, once it settled; its conversation stays recorded. */
export async function forgetRunningPiSubagent(tx: Tx, requestId: string): Promise<void> {
  delete (await tx.doc(PiRunningSubagentsDoc)).running[requestId];
}

/** The conversation of the subagent `requestId` started; null when it started none. */
export async function piSubagentConversation(
  read: DocumentReader,
  requestId: string,
  context: Context,
): Promise<ConversationId | null> {
  const subagent = await read.snapshot(PiSubagentDoc, requestId, context);
  return subagent?.status === "starting" || subagent?.status === "started"
    ? (subagent.conversationId as ConversationId)
    : null;
}

/** Watches the subagent `requestId` asked for; undefined when the agent has none by that ID. */
export async function watchPiSubagent(
  observer: DocumentObserver,
  requestId: string,
  context: Context,
): Promise<DocumentWatch<PiSubagentState> | undefined> {
  return await observer.watchDoc(PiSubagentDoc, requestId, context);
}

/** The conversations of subagents that may still run. */
export async function runningPiSubagentConversations(
  read: DocumentReader,
  context: Context,
): Promise<ConversationId[]> {
  const subagents = await read.snapshot(PiRunningSubagentsDoc, context);
  return Object.values(subagents?.running ?? {}) as ConversationId[];
}

/**
 * The conversation a model request comes from, by the provider session ID Pi sends with it: the
 * root's, or a running subagent's. Null for any other, which has no turn to run as.
 */
export async function piConversationOfSession(
  read: DocumentReader,
  sessionId: string,
  context: Context,
): Promise<ConversationId | null> {
  for (const conversationId of [
    ROOT_CONVERSATION_ID,
    ...(await runningPiSubagentConversations(read, context)),
  ]) {
    if ((await read.snapshot(ProviderDoc, conversationId, context))?.sessionId === sessionId) {
      return conversationId;
    }
  }
  return null;
}
