import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  PiOlderSubagents,
  PiSubagentAsk,
  PiSubagentSummary,
} from "@fragno-dev/backoffice-api/v0/pi";

import {
  defineDoc,
  defineDocFamily,
  defineTask,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  SubmissionSettled,
  type ConversationId,
  type Cursor,
  type DocumentObserver,
  type DocumentReader,
  type DocumentWatch,
  type EntryId,
  type Harness,
  type Storage,
  type TaskGraph,
  type TaskId,
  type TaskRecord,
  type Tx,
} from "@earendil-works/pi-durable";

/**
 * Where a subagent stands, as its agent knows it: waiting in the queue for a slot, or dropped
 * before it started. Once the queue starts it, its anchor task owns it (see `PiSubagentAnchorTask`):
 * `starting` until its conversation exists, `opened` until its prompt is submitted there, then
 * `started`. One `interrupted` started before anchors, in a conversation of its own, and its
 * handover may have stopped before its prompt was submitted there; the next one finds out.
 */
export type PiSubagentState =
  | { status: "waiting" }
  | { status: "dropped"; reason: string }
  | { status: "interrupted"; conversationId: number }
  | { status: "starting"; taskId: number }
  | { status: "opened"; taskId: number; conversationId: number }
  | { status: "started"; conversationId: number };

/**
 * A subagent of the agent, by the request ID that asked for it, from when the queue takes it. It
 * stays after the subagent ends, so its submission and transcript stay readable by that request
 * ID, and those waiting for it can watch it before it starts.
 */
const PiSubagentDoc = defineDocFamily<PiSubagentState, PiSubagentState>({
  kind: "backoffice.pi.subagent",
  version: 3,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  migrate: (value, fromVersion) => {
    // Version 1 recorded only started subagents, by their conversation. Version 2 had no anchor
    // tasks; one it left starting had its conversation, but perhaps no prompt there yet.
    if (fromVersion === 1) {
      return { status: "started", conversationId: value.conversationId as number };
    }
    if (value.status === "starting") {
      return { status: "interrupted", conversationId: value.conversationId as number };
    }
    return value as PiSubagentState;
  },
  checkpointWhen: () => true,
});

/**
 * What the subagents waiting for a slot were asked, by request ID, so the agent's viewers see them
 * before they start.
 */
const PiWaitingSubagentsDoc = defineDoc<{ waiting: { [requestId: string]: PiSubagentAsk } }>({
  kind: "backoffice.pi.subagents.waiting",
  version: 1,
  scope: "session",
  initial: () => ({ waiting: {} }),
  // Each subagent adds and removes its entry; a base every 32 changes keeps reopening cheap.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/**
 * Records that the queue holds a subagent until a slot frees; one it already started, or dropped,
 * stays. Returns whether it waits.
 */
export async function recordWaitingPiSubagent(tx: Tx, ask: PiSubagentAsk): Promise<boolean> {
  const recorded = await tx.doc(PiSubagentDoc, ask.requestId, { status: "waiting" });
  if (recorded.status !== "waiting") {
    return false;
  }
  (await tx.doc(PiWaitingSubagentsDoc)).waiting[ask.requestId] = ask;
  return true;
}

/**
 * Records that the queue dropped a subagent that waited; one it already started stays. Returns
 * what it was asked, when it was dropped now; null otherwise.
 */
export async function recordDroppedPiSubagent(
  tx: Tx,
  requestId: string,
  reason: string,
): Promise<PiSubagentAsk | null> {
  const recorded = await tx.doc(PiSubagentDoc, requestId, { status: "dropped", reason });
  if (recorded.status !== "waiting") {
    return null;
  }
  replaceState(recorded, { status: "dropped", reason });
  const { waiting } = await tx.doc(PiWaitingSubagentsDoc);
  const ask = waiting[requestId] ?? null;
  delete waiting[requestId];
  return ask && { ...ask };
}

/**
 * The oldest subagents waiting for a slot, up to `limit`, as their viewers see them: those start
 * first.
 */
export async function readWaitingPiSubagents(
  read: DocumentReader,
  limit: number,
  context: Context,
): Promise<PiSubagentSummary[]> {
  const waiting = (await read.snapshot(PiWaitingSubagentsDoc, context))?.waiting ?? {};
  return Object.values(waiting)
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt))
    .slice(0, limit)
    .map((ask) => ({ ...ask, state: { status: "waiting" } }));
}

/** What a subagent's anchor task was given: what it was asked, and when it started. */
type PiSubagentAnchorInput = { ask: PiSubagentAsk; startedAt: string };

/**
 * How a subagent ended, as its anchor task completes with it: answered by entry `answer` of its
 * conversation, which says when, or stopped or failed.
 */
type PiSubagentAnchorResult =
  | { status: "answered"; startedAt: string; answer: number }
  | Extract<PiSubagentSummary["state"], { status: "stopped" | "failed" }>;

const ANSWERED = "answered";

/**
 * Owns a subagent's conversation, as Pi Durable's background subagents are owned: it lives in the
 * agent's own conversation as a background task, so the agent's turns neither wait for it nor stop
 * it, while stopping the agent's background work stops it and its conversation's work. Its handover
 * creates the conversation and submits the prompt there, asking Pi to signal it once the prompt
 * settles; it then ends with how the subagent ended. Pi lists the conversations of the agent's
 * conversation by owner, so its anchors are the agent's subagents, live or ended.
 */
const PiSubagentAnchorTask = defineTask<
  PiSubagentAnchorInput,
  { phase: "start" } | { phase: "settled" },
  PiSubagentAnchorResult
>({
  name: "backoffice.pi.subagent",
  version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: async (_task, runtime, context) => {
      // A prompt that settled before this ran has signalled already, which wakes it at once.
      await runtime.commit(
        () => ({
          status: "sleeping",
          checkpoint: { phase: "settled" },
          signals: [SubmissionSettled.key(ANSWERED)],
        }),
        context,
      );
    },
    settled: async (task, runtime, context) => {
      const settled = await runtime.readSignal(SubmissionSettled, ANSWERED, context);
      if (settled?.kind !== "value") {
        throw new Error("A subagent's anchor woke before its prompt settled.");
      }
      const submission = settled.value;
      const { startedAt } = task.input;
      if (submission.status === "done" && submission.answer === undefined) {
        throw new Error("A subagent's prompt settled done without an answer.");
      }
      const result: PiSubagentAnchorResult =
        submission.status === "done"
          ? { status: "answered", startedAt, answer: submission.answer }
          : submission.reason === ABORTED_REASON
            ? { status: "stopped", startedAt }
            : { status: "failed", startedAt, reason: submission.reason };
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result } }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/** The tasks Backoffice's extension registers for subagents. */
export const PI_SUBAGENT_TASKS = [PiSubagentAnchorTask] as const;

/** Pi settles a prompt a stop cut off as unanswered with this reason. */
const ABORTED_REASON = "aborted";

/**
 * Starts a subagent's anchor task, unless a handover of it already did: the first step of its
 * start. Returns where its start stands. An anchor a stop ended before the subagent's
 * conversation existed, or before its prompt was submitted there, started nothing anyone sees, so
 * a later handover starts it again.
 */
export async function startPiSubagentAnchor(
  harness: Harness,
  ask: PiSubagentAsk,
  startedAt: number,
  context: Context,
): Promise<PiSubagentState> {
  return await harness.commit(async (tx) => {
    const recorded = await tx.doc(PiSubagentDoc, ask.requestId, { status: "waiting" });
    if (recorded.status === "started") {
      return { ...recorded };
    }
    if (recorded.status === "interrupted") {
      const { conversationId } = recorded;
      if (await tx.submissionByRequest(conversationId as ConversationId, ask.requestId)) {
        const state: PiSubagentState = { status: "started", conversationId };
        replaceState(recorded, state);
        return state;
      }
    }
    if (recorded.status === "opened") {
      // Its prompt may have been submitted, and even settled, before the handover that did failed.
      if (await tx.submissionByRequest(recorded.conversationId as ConversationId, ask.requestId)) {
        return { ...recorded };
      }
    }
    if (recorded.status === "starting" || recorded.status === "opened") {
      const anchor = await tx.task(recorded.taskId as TaskId);
      if (anchor !== undefined && anchor.state.status !== "terminal") {
        return { ...recorded };
      }
    }
    delete (await tx.doc(PiWaitingSubagentsDoc)).waiting[ask.requestId];
    const taskId = await tx.createTask(
      PiSubagentAnchorTask,
      { ask, startedAt: new Date(startedAt).toISOString() },
      {
        ownership: { kind: "conversation" },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      },
    );
    const state: PiSubagentState = { status: "starting", taskId };
    replaceState(recorded, state);
    return state;
  }, context);
}

/**
 * Creates the conversation of the subagent whose anchor `taskId` is, owned by its anchor, unless
 * a handover of it already did; `prepare` sets it up in the creating commit. Returns where its
 * start stands.
 */
export async function openPiSubagentConversation(
  harness: Harness,
  requestId: string,
  taskId: number,
  prepare: (tx: Tx, conversationId: ConversationId) => Promise<void>,
  context: Context,
): Promise<PiSubagentState> {
  return await harness.commit(async (tx) => {
    const recorded = await tx.doc(PiSubagentDoc, requestId, { status: "waiting" });
    if (recorded.status !== "starting" || recorded.taskId !== taskId) {
      return { ...recorded };
    }
    const conversation = await tx.createConversation({
      ownership: { kind: "task", taskId: taskId as TaskId },
    });
    await prepare(tx, conversation.id);
    const state: PiSubagentState = { status: "opened", taskId, conversationId: conversation.id };
    replaceState(recorded, state);
    return state;
  }, context);
}

/**
 * Records that a subagent's prompt is submitted in its conversation, so whoever waits for it
 * finds its submission there.
 */
export async function recordStartedPiSubagent(
  harness: Harness,
  requestId: string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const recorded = await tx.doc(PiSubagentDoc, requestId, { status: "waiting" });
    if (recorded.status === "started") {
      return;
    }
    if (recorded.status !== "opened") {
      throw new Error(`Subagent ${requestId} is ${recorded.status}, not opened.`);
    }
    replaceState(recorded, { status: "started", conversationId: recorded.conversationId });
  }, context);
}

/** The signal a subagent's anchor `taskId` waits for, which its prompt's submission sends. */
export function piSubagentAnchorNotify(taskId: number) {
  return { taskId: taskId as TaskId, key: ANSWERED };
}

// A tracked document changes in place, so a state of another shape replaces its fields.
function replaceState(recorded: PiSubagentState, state: PiSubagentState) {
  for (const key of Object.keys(recorded)) {
    delete (recorded as Record<string, unknown>)[key];
  }
  Object.assign(recorded, state);
}

/** The conversation of the subagent `requestId` started; null when it has none yet. */
export async function piSubagentConversation(
  read: DocumentReader,
  requestId: string,
  context: Context,
): Promise<ConversationId | null> {
  const subagent = await read.snapshot(PiSubagentDoc, requestId, context);
  return subagent?.status === "opened" || subagent?.status === "started"
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

/** The conversations of the subagents whose anchors are live in `graph`, by anchor. */
function liveSubagents(graph: TaskGraph): Map<TaskId, ConversationId | null> {
  const live = new Map<TaskId, ConversationId | null>();
  for (const node of Object.values(graph.tasks)) {
    if (node.kind === PiSubagentAnchorTask.definition.name) {
      live.set(node.id, node.conversations[0] ?? null);
    }
  }
  return live;
}

/** A subagent, by its anchor task and conversation. */
export type PiAnchoredSubagent = { taskId: TaskId; conversationId: ConversationId };

/** The agent's live subagents, as its task graph shows their anchors. */
export type PiLiveSubagents = {
  /** The subagents that run. */
  running(): PiAnchoredSubagent[];
};

/**
 * Follows the agent's subagents through its task graph: `changed` hears of each subagent whose
 * conversation appears, and of each that had one once its anchor ends. It is called as Pi adopts
 * the commit, so it only records what changed.
 */
export async function observePiSubagents(
  harness: Harness,
  changed: (subagents: PiAnchoredSubagent[]) => void,
  context: Context,
): Promise<PiLiveSubagents> {
  let live = new Map<TaskId, ConversationId | null>();
  const observation = await harness.observeTaskGraph(
    {
      advance(call) {
        if (call.kind !== "value") {
          return;
        }
        const next = liveSubagents(call.value);
        const changes = [
          ...[...next].flatMap(([taskId, conversationId]) =>
            conversationId !== null && (live.get(taskId) ?? null) === null
              ? [{ taskId, conversationId }]
              : [],
          ),
          ...[...live].flatMap(([taskId, conversationId]) =>
            conversationId !== null && !next.has(taskId) ? [{ taskId, conversationId }] : [],
          ),
        ];
        live = next;
        if (changes.length > 0) {
          changed(changes);
        }
      },
      end() {},
    },
    context,
  );
  live = liveSubagents(observation.value);
  return {
    running: () =>
      [...live].flatMap(([taskId, conversationId]) =>
        conversationId === null ? [] : [{ taskId, conversationId }],
      ),
  };
}

/**
 * The conversation a model request comes from, by the provider session ID Pi sends with it: the
 * root's, or a running subagent's. Null for any other, which has no turn to run as.
 */
export async function piConversationOfSession(
  read: DocumentReader,
  subagents: PiLiveSubagents,
  sessionId: string,
  context: Context,
): Promise<ConversationId | null> {
  for (const conversationId of [
    ROOT_CONVERSATION_ID,
    ...subagents.running().map((running) => running.conversationId),
  ]) {
    if ((await read.snapshot(ProviderDoc, conversationId, context))?.sessionId === sessionId) {
      return conversationId;
    }
  }
  return null;
}

/**
 * The subagent whose anchor `taskId` is, with conversation `conversationId`, as its viewers see
 * it; null for a conversation its subagent no longer has, which a stop left before its prompt.
 */
export async function readPiSubagentSummary(
  harness: Harness,
  storage: Storage,
  taskId: TaskId,
  conversationId: ConversationId,
  context: Context,
): Promise<PiSubagentSummary | null> {
  const anchor = await harness.getTask(taskId, context);
  if (anchor === undefined || anchor.kind !== PiSubagentAnchorTask.definition.name) {
    return null;
  }
  const { ask, startedAt } = anchor.input as PiSubagentAnchorInput;
  if ((await piSubagentConversation(harness, ask.requestId, context)) !== conversationId) {
    return null;
  }
  return { ...ask, state: await anchorState(storage, anchor, startedAt, conversationId, context) };
}

async function anchorState(
  storage: Storage,
  anchor: TaskRecord<JsonValue, JsonValue, unknown>,
  startedAt: string,
  conversationId: ConversationId,
  context: Context,
): Promise<PiSubagentSummary["state"]> {
  if (anchor.state.status !== "terminal") {
    return { status: "running", startedAt };
  }
  const { outcome } = anchor.state;
  switch (outcome.status) {
    case "completed": {
      const result = outcome.result as PiSubagentAnchorResult;
      if (result.status !== "answered") {
        return result;
      }
      const answeredAt = await answerTime(storage, conversationId, result.answer, context);
      return { status: "answered", startedAt, answeredAt };
    }
    case "aborted":
      return { status: "stopped", startedAt };
    case "failed":
    case "faulted":
      return { status: "failed", startedAt, reason: outcome.error.message };
    case "orphaned":
      return { status: "failed", startedAt, reason: outcome.reason };
  }
  throw new Error("Unsupported task outcome.", { cause: outcome satisfies never });
}

/**
 * When the answer entry `answer` of a subagent's conversation was answered: its last response's
 * end. A response is stamped when its generation starts.
 */
async function answerTime(
  storage: Storage,
  conversationId: ConversationId,
  answer: number,
  context: Context,
): Promise<string> {
  const stored = await storage.entry(conversationId, answer as EntryId, context);
  const response = stored?.entry.model?.filter((message) => message.role === "assistant").at(-1);
  if (response?.role !== "assistant") {
    throw new Error(`Subagent answer ${answer} of conversation ${conversationId} has no response.`);
  }
  return new Date(response.timestamp + (response.durationMs ?? 0)).toISOString();
}

/**
 * A page of the agent's subagents, newest first: up to `limit` conversations its anchors own, from
 * `cursor`, which a page before this one left, or from the newest; `read` reads each, as
 * `readPiSubagentSummary` does.
 */
export async function listPiSubagents(
  storage: Storage,
  cursor: Cursor | null,
  limit: number,
  read: (taskId: TaskId, conversationId: ConversationId) => Promise<PiSubagentSummary | null>,
  context: Context,
): Promise<{ subagents: PiSubagentSummary[]; older: PiOlderSubagents | null }> {
  const page = await storage.scanConversations(
    { ownerConversationId: ROOT_CONVERSATION_ID, order: "descending" },
    limit,
    cursor ?? undefined,
    context,
  );
  const subagents: PiSubagentSummary[] = [];
  for (const conversation of page.items) {
    const owner = conversation.owner?.taskId;
    const summary = owner === undefined ? null : await read(owner, conversation.id);
    if (summary) {
      subagents.push(summary);
    }
  }
  const oldest = page.items.at(-1);
  return {
    subagents,
    older:
      page.next === undefined || oldest === undefined
        ? null
        : { through: oldest.id - 1, cursor: JSON.stringify(page.next) },
  };
}
