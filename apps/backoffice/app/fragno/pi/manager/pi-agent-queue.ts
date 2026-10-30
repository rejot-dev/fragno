import type { PiAgentConfig, PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import type { PiAgentQueueEntry } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext, HookFn, TypedUnitOfWork } from "@fragno-dev/db";

import type { UsageLimitCheck } from "@/fragno/billing/usage-billing";
import {
  admitPiAgentTurn,
  builtInPiAgentDefinition,
  piPromptModel,
  type PiAgentAdmission,
} from "@/fragno/pi/agent/agent-definitions";
import {
  PI_INTERNAL_REQUEST_ID_PREFIX,
  type PiAgent,
  type PiAgentModelChoice,
  type PiAgentNotification,
  type PiAgentPrompt,
  type PiAgentSteer,
  type PiAgentQueueSubmission,
  type PiAgentTurn,
  type PiAgentWaitingQueue,
  type PiQueuedSubagent,
  type PiAgentWork,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import { piNotificationRequestId } from "@/fragno/pi/agent/pi-agent-notification-entry";
import { mayJoinPiAgentTurn, nextPiAgentQueueTurn } from "@/fragno/pi/agent/pi-agent-queue-rules";

import {
  AGENT_QUEUE_REQUEST_INDEX,
  AGENT_QUEUE_STATUS_INDEX,
  AGENT_QUEUE_SUBAGENT_INDEX,
  definitionFromRow,
  piAgentDirectorySchema,
  type PiAgentQueueInput,
  type PiAgentQueueItemState,
  type PiAgentTurnProvenance,
} from "./pi-manager-schema";
import type { PiModelUsage } from "./pi-model-usage";

/** A change a `pi.agent.*` operation made, attributed to whoever asked for it. */
export type PiAgentChange = {
  agentName: string;
  provenance: PiAgentTurnProvenance;
} & (
  | { kind: "created" | "updated" | "deleted"; definition: PiAgentDefinition }
  | { kind: "stopped" | "resumed" }
);

/** What happens to an item that waits in an agent's queue; its sender's provenance attributes it. */
export type PiAgentQueueChange = {
  agentName: string;
  requestId: string;
  provenance: PiAgentTurnProvenance;
} & (
  | { kind: "added"; type: "prompt" | "subagent" | "notification" | "steer" }
  | { kind: "dispatched"; turnRequestId: string }
  | { kind: "dropped"; reason: string }
);

/**
 * How a prompt ended, for the agent whose turn sent it and asked to hear: the `turn.*` event its
 * agent recorded, or that the queue dropped it. The reply carries the prompt's provenance, so the
 * agent handles it with its own turn's authority.
 */
export type PiAgentReply = {
  replyTo: PiAgentConfig;
  provenance: PiAgentTurnProvenance;
  ending:
    | { type: "settled"; event: PiAgentNotification["event"] }
    | { type: "dropped"; agentName: string; requestId: string; reason: string };
};

/** Work the manager's requests leave for durable delivery. */
export type PiManagerHooks = {
  /** Records the change as a `pi` Automations event; the hook's id makes it idempotent. */
  recordAgentChange: HookFn<PiAgentChange>;
  /** Records the change as a `pi` Automations event; the hook's id makes it idempotent. */
  recordQueueChange: HookFn<PiAgentQueueChange>;
  /** Hands the agent its unsettled items again, in case the request that did failed. */
  redispatchAgentQueue: HookFn<{ agentName: string }>;
  /** Writes notifications that arrived into the conversation again, as above. */
  writeNotificationCards: HookFn<{ agent: PiAgentConfig; notifications: PiAgentNotification[] }>;
  /** Tells the agent again that a subagent waits or was dropped, as above. */
  recordSubagent: HookFn<{ agent: PiAgentConfig; requestId: string; subagent: PiQueuedSubagent }>;
  /** Notifies the agent a prompt replies to of how it ended, possibly in another scope. */
  replyToAgent: HookFn<PiAgentReply>;
  /** Bills a model call; the event's id makes repeated deliveries idempotent. */
  deliverModelUsage: HookFn<PiModelUsage>;
};

/**
 * What to hand the agent: a steer that joins its dispatched turn, that turn itself, a subagent to
 * start, or the cards of notifications that arrived while their request waits.
 */
/**
 * Work that starts a turn carries the queue revision that handed it over, so the agent refuses it
 * once a stop at a later revision fenced it (see `PiAgent.abort`).
 */
export type PiAgentHandover =
  | {
      type: "steer";
      agent: PiAgentConfig;
      revision: number;
      turn: PiAgentTurn;
      steer: PiAgentSteer;
    }
  | {
      type: "dispatch";
      agent: PiAgentConfig;
      revision: number;
      turn: PiAgentTurn;
      work: PiAgentWork;
    }
  | {
      type: "subagent";
      agent: PiAgentConfig;
      revision: number;
      turn: PiAgentTurn;
      prompt: PiAgentPrompt;
    }
  | { type: "recordSubagent"; agent: PiAgentConfig; requestId: string; subagent: PiQueuedSubagent }
  | { type: "write"; agent: PiAgentConfig; notifications: PiAgentNotification[] };

/**
 * How many subagents of one agent run at once; more wait, oldest first. Each runs a conversation of
 * its own, so the limit bounds what one agent spends at a time.
 */
export const PI_AGENT_SUBAGENT_LIMIT = 4;

export async function handOverPiAgentWork(
  agents: (config: PiAgentConfig) => PiAgent,
  handover: PiAgentHandover,
): Promise<void> {
  const agent = agents(handover.agent);
  switch (handover.type) {
    case "steer":
      await agent.steer(handover.agent, handover.revision, handover.turn, handover.steer);
      return;
    case "dispatch":
      await agent.dispatch(handover.agent, handover.revision, handover.turn, handover.work);
      return;
    case "subagent":
      await agent.startSubagent(handover.agent, handover.revision, handover.turn, handover.prompt);
      return;
    case "recordSubagent":
      await agent.recordSubagent(handover.agent, handover.requestId, handover.subagent);
      return;
    case "write":
      await agent.writeNotifications(handover.agent, handover.notifications);
      return;
  }
}

/**
 * Shows the agent's viewers what waits in its queue once a change to it commits. The change stands
 * either way, and the next change or a reconnecting viewer publishes again, so a failure is only
 * reported.
 */
export async function publishPiAgentQueue(agent: PiAgent, queue: PiAgentWaitingQueue) {
  try {
    await agent.publishQueue(queue);
  } catch (error) {
    console.error("Publishing a Pi agent's queue to its viewers failed.", error);
  }
}

/** `status` repeats the state's tag so the queue's index can find live items. */
function itemState(state: PiAgentQueueItemState) {
  return { status: state.status, state };
}

type PiAgentQueueItem = { requestId: string; input: PiAgentQueueInput };

/** Work for the agent's own conversation, which does one thing at a time. */
type PiAgentRootInput = Exclude<PiAgentQueueInput, { type: "subagent" }>;

/** Root work that waits for a turn; the queue dispatches its compactions at once. */
type PiAgentTurnInput = Exclude<PiAgentRootInput, { type: "compaction" }>;

type PiAgentSubagentInput = Extract<PiAgentQueueInput, { type: "subagent" }>;

function isRootItem<TItem extends PiAgentQueueItem>(
  item: TItem,
): item is TItem & { input: PiAgentRootInput } {
  return item.input.type !== "subagent";
}

function isTurnItem<TItem extends PiAgentQueueItem>(
  item: TItem,
): item is TItem & { input: PiAgentTurnInput } {
  return item.input.type === "prompt" || item.input.type === "notification";
}

function isSubagentItem<TItem extends PiAgentQueueItem>(
  item: TItem,
): item is TItem & { input: PiAgentSubagentInput } {
  return item.input.type === "subagent";
}

function queueEntry({
  requestId,
  input,
}: PiAgentQueueItem & { input: PiAgentTurnInput }): PiAgentQueueEntry {
  return input.type === "prompt"
    ? { type: "prompt", requestId, content: input.content }
    : {
        type: "notification",
        requestId,
        source: input.notification.event.source,
        eventType: input.notification.event.eventType,
      };
}

/** What waits for the agent's conversation; subagents wait for conversations of their own. */
function waitingQueue(revision: number, paused: boolean, queued: readonly PiAgentQueueItem[]) {
  return {
    revision,
    paused,
    items: queued.filter(isTurnItem).map(queueEntry),
  } satisfies PiAgentWaitingQueue;
}

/**
 * A dispatched turn's work, named by its oldest item, which the queue's rules put first, or a
 * dispatched compaction.
 */
function dispatchedWork(
  items: readonly [
    PiAgentQueueItem & { input: PiAgentRootInput },
    ...(PiAgentQueueItem & { input: PiAgentRootInput })[],
  ],
): PiAgentWork {
  const [head] = items;
  if (head.input.type === "prompt") {
    return { type: "prompt", requestId: head.requestId, content: head.input.content };
  }
  if (head.input.type === "compaction") {
    return { type: "compaction", requestId: head.requestId };
  }
  return {
    type: "notifications",
    requestId: head.requestId,
    notifications: items.flatMap(({ input }) =>
      input.type === "notification" ? [input.notification] : [],
    ),
  };
}

type PiAgentQueueUow = TypedUnitOfWork<typeof piAgentDirectorySchema, [], unknown, PiManagerHooks>;

/**
 * Every change to an agent's queue updates its row, so concurrent changes to one queue conflict and
 * retry. Returns the row's new version, which orders items and the queue's publications.
 */
function changeAgentQueue(uow: PiAgentQueueUow, agent: { id: FragnoId }, paused: boolean) {
  uow.update("agent", agent.id, (b) => b.set({ paused }).check());
  return agent.id.version + 1;
}

/**
 * An agent's definition and provisioning, its dispatched turn, what waits, and the steers that have
 * not settled.
 */
function findAgentQueue(uow: PiAgentQueueUow, agentName: string) {
  return uow
    .findFirst("agent_definition", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
    .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
    .find("agent_queue_item", (b) =>
      b
        .whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
          eb.and(eb("agentName", "=", agentName), eb("status", "=", "dispatched")),
        )
        .orderByIndex(AGENT_QUEUE_STATUS_INDEX, "asc"),
    )
    .find("agent_queue_item", (b) =>
      b
        .whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
          eb.and(eb("agentName", "=", agentName), eb("status", "=", "queued")),
        )
        .orderByIndex(AGENT_QUEUE_STATUS_INDEX, "asc"),
    )
    .find("agent_queue_item", (b) =>
      b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
        eb.and(eb("agentName", "=", agentName), eb("status", "=", "steered")),
      ),
    );
}

/**
 * Whether the agent's conversation is busy with what the queue handed it: a dispatched turn or
 * compaction, or a steer that has not settled. Pi starts a steer it takes at a turn's final answer
 * as that turn settles, so the conversation is free only once its steers settled too.
 */
function isConversationBusy(
  dispatched: readonly PiAgentQueueItem[],
  steered: readonly PiAgentQueueItem[],
) {
  return dispatched.some(isRootItem) || steered.length > 0;
}

/** Who sent an item, and the agent it replies to once it ends. */
type PiAgentQueueSender = { provenance: PiAgentTurnProvenance; replyTo: PiAgentConfig | null };

/** An item this change records, which has no row yet. */
type PiAgentArrivingItem = PiAgentQueueItem &
  PiAgentQueueSender & {
    agentName: string;
    position: number;
  };
type PiAgentQueueRow = PiAgentQueueItem & PiAgentQueueSender & { id: FragnoId };
type PiAgentTurnRow = PiAgentQueueRow & { input: PiAgentTurnInput };

function replyIfAsked(
  uow: PiAgentQueueUow,
  item: PiAgentQueueSender,
  ending: PiAgentReply["ending"],
) {
  if (item.replyTo) {
    uow.triggerHook("replyToAgent", { replyTo: item.replyTo, provenance: item.provenance, ending });
  }
}

/**
 * Only work that waits is recorded: queued items, and steers, which wait in Pi's inbox for the
 * running turn's next tool boundary. Work an idle agent takes at once records nothing.
 */
function recordQueueChange(
  uow: PiAgentQueueUow,
  agentName: string,
  item: { requestId: string; input: PiAgentTurnInput | PiAgentSubagentInput } & {
    provenance: PiAgentTurnProvenance;
  },
  change:
    | { kind: "added"; steer: boolean }
    | { kind: "dispatched"; turnRequestId: string }
    | { kind: "dropped"; reason: string },
) {
  const { requestId, provenance } = item;
  uow.triggerHook("recordQueueChange", {
    agentName,
    requestId,
    provenance,
    ...(change.kind === "added"
      ? { kind: "added", type: change.steer ? "steer" : item.input.type }
      : change),
  });
}

/**
 * Starts the next turn, which only happens while nothing is dispatched and the queue is not
 * paused: the rules' items are dispatched, or every candidate is dropped when the definition or
 * model they need is gone. Returns what still waits.
 */
function startNextTurn(
  uow: PiAgentQueueUow,
  input: {
    agent: PiAgentConfig;
    revision: number;
    definition: PiAgentDefinition | null;
    availableModels: readonly PiAvailableModel[];
    queued: readonly PiAgentTurnRow[];
    arriving: (PiAgentArrivingItem & { input: PiAgentTurnInput }) | null;
  },
): { handover: PiAgentHandover | null; waiting: PiAgentQueueItem[] } {
  const { agent, arriving } = input;
  const candidates = [...input.queued, ...(arriving ? [{ ...arriving, id: null }] : [])];
  function record(candidate: (typeof candidates)[number], state: PiAgentQueueItemState) {
    if (candidate.id) {
      uow.update("agent_queue_item", candidate.id, (b) => b.set(itemState(state)));
    } else if (arriving) {
      uow.create("agent_queue_item", { ...arriving, ...itemState(state) });
    }
  }
  const step = nextPiAgentQueueTurn(
    candidates,
    input.definition,
    agent.agentName,
    input.availableModels,
  );
  if (step.type === "idle") {
    return { handover: null, waiting: [] };
  }
  if (step.type === "drop") {
    for (const candidate of candidates) {
      record(candidate, { status: "dropped", reason: step.reason });
      if (candidate.id) {
        recordQueueChange(uow, agent.agentName, candidate, {
          kind: "dropped",
          reason: step.reason,
        });
      }
      replyIfAsked(uow, candidate, {
        type: "dropped",
        agentName: agent.agentName,
        requestId: candidate.requestId,
        reason: step.reason,
      });
    }
    return { handover: null, waiting: [] };
  }
  const turnRequestId = step.items[0].requestId;
  const waiting = candidates.filter((candidate) => !step.items.includes(candidate));
  for (const candidate of step.items) {
    record(candidate, { status: "dispatched", turn: step.turn, turnRequestId });
    if (candidate.id) {
      recordQueueChange(uow, agent.agentName, candidate, { kind: "dispatched", turnRequestId });
    }
  }
  for (const candidate of waiting) {
    if (!candidate.id) {
      record(candidate, { status: "queued" });
      recordQueueChange(uow, agent.agentName, candidate, { kind: "added", steer: false });
    }
  }
  uow.triggerHook("redispatchAgentQueue", { agentName: agent.agentName });
  return {
    handover: {
      type: "dispatch",
      agent,
      revision: input.revision,
      turn: step.turn,
      work: dispatchedWork(step.items),
    },
    waiting,
  };
}

/** Where an admitted item went, what to hand the agent now, and what waits after it. */
type PiAgentPlacement = {
  status: "steered" | "queued";
  handovers: PiAgentHandover[];
  queue: PiAgentWaitingQueue;
};

/**
 * Records an admitted item at the agent's new version: steering the dispatched turn when
 * `steering` is the item and the turn's sender sent it, waiting behind the dispatched turn or
 * compaction or in a paused queue, or starting the next turn when nothing runs. A notification that
 * waits has its card written at once; only the request to handle it waits.
 */
function placeQueueItem(
  uow: PiAgentQueueUow,
  input: {
    agent: PiAgentConfig;
    revision: number;
    paused: boolean;
    item: PiAgentQueueItem & { input: PiAgentTurnInput } & PiAgentQueueSender;
    turn: PiAgentTurn;
    steering: PiAgentSteer | null;
    definition: PiAgentDefinition | null;
    availableModels: readonly PiAvailableModel[];
    dispatched: (PiAgentQueueItem & { state: PiAgentQueueItemState }) | undefined;
    busy: boolean;
    queued: readonly PiAgentTurnRow[];
  },
): PiAgentPlacement {
  const { agent, revision, paused, turn, dispatched, queued } = input;
  const { agentName } = agent;
  const arriving = { ...input.item, agentName, position: revision };
  if (
    !paused &&
    input.steering &&
    // A steer would start a turn beside the compaction, which the next turn waits for instead.
    dispatched?.input.type !== "compaction" &&
    dispatched?.state.status === "dispatched" &&
    mayJoinPiAgentTurn(dispatched.state.turn, turn)
  ) {
    uow.create("agent_queue_item", { ...arriving, ...itemState({ status: "steered", turn }) });
    recordQueueChange(uow, agentName, arriving, { kind: "added", steer: true });
    uow.triggerHook("redispatchAgentQueue", { agentName });
    return {
      status: "steered",
      handovers: [{ type: "steer", agent, revision, turn, steer: input.steering }],
      queue: waitingQueue(revision, paused, queued),
    };
  }
  if (paused || input.busy) {
    uow.create("agent_queue_item", { ...arriving, ...itemState({ status: "queued" }) });
    recordQueueChange(uow, agentName, arriving, { kind: "added", steer: false });
    const queue = waitingQueue(revision, paused, [...queued, arriving]);
    if (arriving.input.type === "prompt") {
      return { status: "queued", handovers: [], queue };
    }
    const notifications = [arriving.input.notification];
    uow.triggerHook("writeNotificationCards", { agent, notifications });
    return { status: "queued", handovers: [{ type: "write", agent, notifications }], queue };
  }
  // Nothing runs, so nothing waits unless the queue was just resumed.
  const started = startNextTurn(uow, {
    agent,
    revision,
    definition: input.definition,
    availableModels: input.availableModels,
    queued,
    arriving,
  });
  return {
    status: "queued",
    handovers: started.handover ? [started.handover] : [],
    queue: waitingQueue(revision, paused, started.waiting),
  };
}

/**
 * Starts waiting subagents, oldest first, while fewer than the limit run and the queue is not
 * paused; an arriving one that cannot start waits. One whose definition or model is gone is
 * dropped, without holding back the others: each runs on its own. Returns their handovers.
 */
function startSubagents(
  uow: PiAgentQueueUow,
  input: {
    agent: PiAgentConfig;
    revision: number;
    paused: boolean;
    definition: PiAgentDefinition | null;
    availableModels: readonly PiAvailableModel[];
    running: number;
    queued: readonly PiAgentQueueRow[];
    arriving: PiAgentArrivingItem | null;
  },
): PiAgentHandover[] {
  const { agent, arriving } = input;
  const handovers: PiAgentHandover[] = [];
  // Its agent knows of every subagent from when it arrives, so a turn can wait for it by its ID.
  function tell(requestId: string, subagent: PiQueuedSubagent) {
    uow.triggerHook("recordSubagent", { agent, requestId, subagent });
    handovers.push({ type: "recordSubagent", agent, requestId, subagent });
  }
  if (arriving && isSubagentItem(arriving)) {
    tell(arriving.requestId, { status: "waiting" });
  }
  let started = 0;
  let running = input.running;
  for (const candidate of [
    ...input.queued.filter(isSubagentItem),
    ...(arriving && isSubagentItem(arriving) ? [{ ...arriving, id: null }] : []),
  ]) {
    function record(state: PiAgentQueueItemState) {
      if (candidate.id) {
        uow.update("agent_queue_item", candidate.id, (b) => b.set(itemState(state)));
      } else if (arriving) {
        uow.create("agent_queue_item", { ...arriving, subagent: true, ...itemState(state) });
      }
    }
    if (input.paused || running >= PI_AGENT_SUBAGENT_LIMIT) {
      if (!candidate.id) {
        record({ status: "queued" });
        recordQueueChange(uow, agent.agentName, candidate, { kind: "added", steer: false });
      }
      continue;
    }
    const admitted = admitPiAgentTurn(
      input.definition,
      agent.agentName,
      candidate.provenance,
      input.availableModels,
      candidate.input.model,
    );
    if (admitted.type === "error") {
      record({ status: "dropped", reason: admitted.message });
      tell(candidate.requestId, { status: "dropped", reason: admitted.message });
      if (candidate.id) {
        recordQueueChange(uow, agent.agentName, candidate, {
          kind: "dropped",
          reason: admitted.message,
        });
      }
      replyIfAsked(uow, candidate, {
        type: "dropped",
        agentName: agent.agentName,
        requestId: candidate.requestId,
        reason: admitted.message,
      });
      continue;
    }
    // A subagent's turn is its own, under its own request ID.
    record({ status: "dispatched", turn: admitted.turn, turnRequestId: candidate.requestId });
    if (candidate.id) {
      recordQueueChange(uow, agent.agentName, candidate, {
        kind: "dispatched",
        turnRequestId: candidate.requestId,
      });
    }
    handovers.push({
      type: "subagent",
      agent,
      revision: input.revision,
      turn: admitted.turn,
      prompt: { requestId: candidate.requestId, content: candidate.input.content },
    });
    running += 1;
    started += 1;
  }
  if (started > 0) {
    uow.triggerHook("redispatchAgentQueue", { agentName: agent.agentName });
  }
  return handovers;
}

/**
 * Starts what a resumed queue holds back: its waiting subagents up to the limit and, unless a turn
 * of the agent's own conversation is still dispatched, its next turn. Work handed over before the
 * stop that the stop fenced or whose handover failed is handed over again by the queue's hook.
 * Returns the new handovers and what still waits for the agent's conversation.
 */
function startResumedQueue(
  uow: PiAgentQueueUow,
  input: {
    agent: PiAgentConfig;
    revision: number;
    definition: PiAgentDefinition | null;
    availableModels: readonly PiAvailableModel[];
    dispatched: readonly PiAgentQueueRow[];
    steered: readonly PiAgentQueueRow[];
    queued: readonly PiAgentQueueRow[];
    arrivingSubagent: PiAgentArrivingItem | null;
  },
): { handovers: PiAgentHandover[]; waiting: PiAgentQueueItem[] } {
  uow.triggerHook("redispatchAgentQueue", { agentName: input.agent.agentName });
  const subagents = startSubagents(uow, {
    agent: input.agent,
    revision: input.revision,
    paused: false,
    definition: input.definition,
    availableModels: input.availableModels,
    running: input.dispatched.filter(isSubagentItem).length,
    queued: input.queued,
    arriving: input.arrivingSubagent,
  });
  if (isConversationBusy(input.dispatched, input.steered)) {
    return { handovers: subagents, waiting: [...input.queued] };
  }
  const started = startNextTurn(uow, {
    agent: input.agent,
    revision: input.revision,
    definition: input.definition,
    availableModels: input.availableModels,
    queued: input.queued.filter(isTurnItem),
    arriving: null,
  });
  return {
    handovers: [...(started.handover ? [started.handover] : []), ...subagents],
    waiting: started.waiting,
  };
}

/** A subagent the agent ran or will run, newest first in its list. */
export type PiAgentSubagentItem = {
  requestId: string;
  task: string;
  submittedAt: string;
  askingToolCall: string | null;
  provenance: PiAgentTurnProvenance;
  state: PiAgentQueueItemState;
};

/**
 * What the queue knows of a request: its own record while it waits or once dropped, or the Pi
 * request of the turn that took it, whose submission is the request's.
 */
export type PiAgentQueueRecord =
  | { type: "held"; submission: PiAgentQueueSubmission }
  | { type: "turn"; turnRequestId: string };

/** Each agent's queue: the items waiting for a turn, the turn Pi runs, and the ones that ended. */
export function piAgentQueueServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<PiManagerHooks>>,
  ) => TService,
  config: { scope: BackofficeContextScope },
) {
  function agentConfig(agentName: string): PiAgentConfig {
    return { scope: config.scope, agentName };
  }

  function definitionOf(
    agentName: string,
    row: Parameters<typeof definitionFromRow>[0] | null,
  ): PiAgentDefinition | null {
    return builtInPiAgentDefinition(agentName) ?? (row ? definitionFromRow(row) : null);
  }

  return defineService({
    /**
     * Admits a prompt and places it. The first prompt provisions the agent. A request ID the queue
     * has seen keeps its first placement and never runs twice. `whenPaused: "resume"` resumes a
     * paused queue, which then starts with its oldest item. `model` is the built-in agent's choice
     * for the prompt's turn; null keeps the conversation's. `replyTo`, an agent whose turn sent the
     * prompt, hears how it ends. A `subagent` prompt runs in a new conversation of the agent,
     * beside its other work, once fewer than the limit run; `whenBusy` concerns only the agent's
     * own conversation. `allowance` refuses only new prompts: a seen request ID was already
     * admitted, and its retry recovers its receipt.
     */
    submitPrompt: function (input: {
      agentName: string;
      prompt: PiAgentPrompt;
      /** Null for a prompt to the agent's own conversation. */
      subagent: { askingToolCall: string | null } | null;
      submittedAt: Date;
      model: PiAgentModelChoice | null;
      whenBusy: "followUp" | "steer" | "reject";
      whenPaused: "wait" | "resume";
      provenance: PiAgentTurnProvenance;
      replyTo: PiAgentConfig | null;
      availableModels: readonly PiAvailableModel[];
      allowance: UsageLimitCheck;
    }) {
      const { agentName, prompt } = input;
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          findAgentQueue(uow, agentName).findFirst("agent_queue_item", (b) =>
            b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
              eb.and(eb("agentName", "=", agentName), eb("requestId", "=", prompt.requestId)),
            ),
          ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, dispatchedItems, queued, steered, submitted],
          }):
            | Extract<PiAgentAdmission, { type: "error" }>
            | Extract<ReturnType<typeof piPromptModel>, { type: "error" }>
            | { type: "busy" }
            | { type: "limited"; message: string }
            | ({ type: "placed" } & PiAgentPlacement) => {
            if (submitted) {
              return {
                type: "placed",
                status: submitted.state.status === "steered" ? "steered" : "queued",
                // A retried subagent tells its agent of it again, as its first submission may not.
                handovers: isSubagentItem(submitted)
                  ? [
                      {
                        type: "recordSubagent",
                        agent: agentConfig(agentName),
                        requestId: prompt.requestId,
                        subagent:
                          submitted.state.status === "dropped"
                            ? { status: "dropped", reason: submitted.state.reason }
                            : { status: "waiting" },
                      },
                    ]
                  : [],
                queue: waitingQueue(agent?.id.version ?? 0, agent?.paused ?? false, queued),
              };
            }
            if (input.allowance.kind === "exhausted") {
              return { type: "limited", message: input.allowance.message };
            }
            const [dispatched] = dispatchedItems.filter(isRootItem);
            const definition = definitionOf(agentName, definitionRow);
            // A subagent's conversation is new, so a built-in agent's starts on its default model.
            const provisioned = Boolean(agent) && !input.subagent;
            const chosen = definition
              ? piPromptModel(definition, input.model, provisioned, input.availableModels)
              : null;
            if (chosen?.type === "error") {
              return chosen;
            }
            const model = chosen?.model ?? null;
            const admitted = admitPiAgentTurn(
              definition,
              agentName,
              input.provenance,
              input.availableModels,
              model,
            );
            if (admitted.type === "error") {
              return admitted;
            }
            // A paused queue can hold work with nothing dispatched.
            if (
              !input.subagent &&
              input.whenBusy === "reject" &&
              (isConversationBusy(dispatchedItems, steered) || queued.some(isRootItem))
            ) {
              return { type: "busy" };
            }
            const paused = (agent?.paused ?? false) && input.whenPaused === "wait";
            if (agent?.paused && !paused) {
              uow.triggerHook("recordAgentChange", {
                kind: "resumed",
                agentName,
                provenance: input.provenance,
              });
            }
            if (!agent) {
              // A concurrent first prompt may provision the agent first; the retry then finds it.
              uow.create("agent", { id: agentName }, { retryOnUniqueConflict: () => true });
            }
            // A new row starts at version 0.
            const revision = agent ? changeAgentQueue(uow, agent, paused) : 0;
            // Resuming the queue starts the subagents that waited, older than any arriving one.
            const resumed = Boolean(agent?.paused) && !paused;
            const subagents = (arriving: PiAgentArrivingItem | null) =>
              arriving || resumed
                ? startSubagents(uow, {
                    agent: agentConfig(agentName),
                    revision,
                    paused,
                    definition,
                    availableModels: input.availableModels,
                    running: dispatchedItems.filter(isSubagentItem).length,
                    queued,
                    arriving,
                  })
                : [];
            if (input.subagent) {
              const arriving: PiAgentArrivingItem = {
                requestId: prompt.requestId,
                input: {
                  type: "subagent",
                  content: prompt.content,
                  model,
                  submittedAt: input.submittedAt.toISOString(),
                  askingToolCall: input.subagent.askingToolCall,
                },
                provenance: input.provenance,
                replyTo: input.replyTo,
                agentName,
                position: revision,
              };
              if (resumed) {
                // Resuming resumes the agent's own conversation too, which may hold waiting turns.
                const started = startResumedQueue(uow, {
                  agent: agentConfig(agentName),
                  revision,
                  definition,
                  availableModels: input.availableModels,
                  dispatched: dispatchedItems,
                  steered,
                  queued,
                  arrivingSubagent: arriving,
                });
                return {
                  type: "placed",
                  status: "queued",
                  handovers: started.handovers,
                  queue: waitingQueue(revision, false, started.waiting),
                };
              }
              return {
                type: "placed",
                status: "queued",
                handovers: subagents(arriving),
                queue: waitingQueue(revision, paused, queued),
              };
            }
            const placement = placeQueueItem(uow, {
              agent: agentConfig(agentName),
              revision,
              paused,
              item: {
                requestId: prompt.requestId,
                input: { type: "prompt", content: prompt.content, model },
                provenance: input.provenance,
                replyTo: input.replyTo,
              },
              turn: admitted.turn,
              // The stopped turn may still be settling, and a steer never joins it.
              steering:
                input.whenBusy === "steer" && !agent?.paused ? { type: "prompt", ...prompt } : null,
              definition,
              availableModels: input.availableModels,
              dispatched,
              busy: isConversationBusy(dispatchedItems, steered),
              queued: queued.filter(isTurnItem),
            });
            return {
              type: "placed",
              ...placement,
              handovers: [...placement.handovers, ...subagents(null)],
            };
          },
        )
        .build();
    },
    /**
     * Admits a notification and places it like a queued prompt, except that it joins the
     * dispatched turn when that turn's sender sent it, such as a prompt the turn sent that ended:
     * the turn sees the event anyway, so a turn of its own would only find it handled. A first
     * prompt provisions the conversation; notifications only address agents already started.
     * Redelivering one event through one route, or to the agent directly, finds the item it placed
     * first.
     */
    submitNotification: function (input: {
      agentName: string;
      notification: PiAgentNotification;
      provenance: PiAgentTurnProvenance;
      availableModels: readonly PiAvailableModel[];
    }) {
      const { agentName, notification } = input;
      const requestId = piNotificationRequestId(notification);
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          findAgentQueue(uow, agentName).findFirst("agent_queue_item", (b) =>
            b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
              eb.and(eb("agentName", "=", agentName), eb("requestId", "=", requestId)),
            ),
          ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, dispatchedItems, queued, steered, submitted],
          }):
            | Extract<PiAgentAdmission, { type: "error" }>
            | { type: "not-started" }
            | ({ type: "placed" } & PiAgentPlacement) => {
            if (!agent) {
              return { type: "not-started" };
            }
            if (submitted) {
              return {
                type: "placed",
                status: "queued",
                handovers: [],
                queue: waitingQueue(agent.id.version, agent.paused, queued),
              };
            }
            const definition = definitionOf(agentName, definitionRow);
            const admitted = admitPiAgentTurn(
              definition,
              agentName,
              input.provenance,
              input.availableModels,
              null,
            );
            if (admitted.type === "error") {
              return admitted;
            }
            const placement = placeQueueItem(uow, {
              agent: agentConfig(agentName),
              revision: changeAgentQueue(uow, agent, agent.paused),
              paused: agent.paused,
              item: {
                requestId,
                input: { type: "notification", notification },
                provenance: input.provenance,
                replyTo: null,
              },
              turn: admitted.turn,
              steering: { type: "notification", notification },
              definition,
              availableModels: input.availableModels,
              dispatched: dispatchedItems.find(isRootItem),
              busy: isConversationBusy(dispatchedItems, steered),
              queued: queued.filter(isTurnItem),
            });
            return { type: "placed", ...placement };
          },
        )
        .build();
    },
    /**
     * Records a settled turn, steer, or compaction. When it was the dispatched turn, every item it
     * handled settles. Once the conversation is free, with no steer left to settle, the next turn
     * starts unless the queue is paused, or first a compaction when `compact` says the context
     * outgrew its threshold. When it was a subagent's, the next waiting subagent starts in its
     * place. `ended` is the event recording how the turn ended, which its prompt's `replyTo` hears.
     * Null when the turn was not the queue's.
     */
    advanceAgentQueue: function (input: {
      agentName: string;
      settledRequestId: string;
      ended: PiAgentNotification["event"] | null;
      compact: boolean;
      availableModels: readonly PiAvailableModel[];
    }) {
      const { agentName } = input;
      // Named by the settlement it follows, so each compacts at most once.
      const compactionRequestId = `${PI_INTERNAL_REQUEST_ID_PREFIX.compaction}${input.settledRequestId}`;
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          findAgentQueue(uow, agentName).findFirst("agent_queue_item", (b) =>
            b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
              eb.and(eb("agentName", "=", agentName), eb("requestId", "=", input.settledRequestId)),
            ),
          ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, dispatched, queued, steered, settled],
          }): { handovers: PiAgentHandover[]; queue: PiAgentWaitingQueue } | null => {
            if (
              !agent ||
              (settled?.state.status !== "dispatched" && settled?.state.status !== "steered")
            ) {
              return null;
            }
            const revision = changeAgentQueue(uow, agent, agent.paused);
            if (input.ended) {
              replyIfAsked(uow, settled, { type: "settled", event: input.ended });
            }
            const definition = definitionOf(agentName, definitionRow);
            if (isSubagentItem(settled)) {
              uow.update("agent_queue_item", settled.id, (b) =>
                b.set(itemState({ status: "settled", turnRequestId: settled.requestId })),
              );
              return {
                handovers: startSubagents(uow, {
                  agent: agentConfig(agentName),
                  revision,
                  paused: agent.paused,
                  definition,
                  availableModels: input.availableModels,
                  running: dispatched.filter(isSubagentItem).length - 1,
                  queued,
                  arriving: null,
                }),
                queue: waitingQueue(revision, agent.paused, queued),
              };
            }
            if (settled.state.status === "steered") {
              uow.update("agent_queue_item", settled.id, (b) =>
                b.set(itemState({ status: "settled", turnRequestId: settled.requestId })),
              );
            } else {
              for (const item of dispatched.filter(isRootItem)) {
                if (item.state.status === "dispatched") {
                  const { turnRequestId } = item.state;
                  uow.update("agent_queue_item", item.id, (b) =>
                    b.set(itemState({ status: "settled", turnRequestId })),
                  );
                }
              }
            }
            const busy =
              settled.state.status === "steered"
                ? isConversationBusy(
                    dispatched,
                    steered.filter(({ requestId }) => requestId !== settled.requestId),
                  )
                : steered.length > 0;
            if (busy) {
              return { handovers: [], queue: waitingQueue(revision, agent.paused, queued) };
            }
            if (agent.paused) {
              return { handovers: [], queue: waitingQueue(revision, true, queued) };
            }
            if (input.compact) {
              const { turn } = settled.state;
              uow.create("agent_queue_item", {
                agentName,
                position: revision,
                requestId: compactionRequestId,
                input: { type: "compaction" },
                provenance: settled.provenance,
                replyTo: null,
                ...itemState({ status: "dispatched", turn, turnRequestId: compactionRequestId }),
              });
              uow.triggerHook("redispatchAgentQueue", { agentName });
              return {
                handovers: [
                  {
                    type: "dispatch",
                    agent: agentConfig(agentName),
                    revision,
                    turn,
                    work: { type: "compaction", requestId: compactionRequestId },
                  },
                ],
                queue: waitingQueue(revision, false, queued),
              };
            }
            const started = startNextTurn(uow, {
              agent: agentConfig(agentName),
              revision,
              definition,
              availableModels: input.availableModels,
              queued: queued.filter(isTurnItem),
              arriving: null,
            });
            return {
              handovers: started.handover ? [started.handover] : [],
              queue: waitingQueue(revision, false, started.waiting),
            };
          },
        )
        .build();
    },
    /**
     * Stopping an agent pauses its queue, so what waits stays until the queue is resumed. Null when
     * the agent has not started.
     */
    pauseAgentQueue: function (agentName: string, provenance: PiAgentTurnProvenance) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => findAgentQueue(uow, agentName))
        .mutate(({ uow, retrieveResult: [, agent, , queued] }): PiAgentWaitingQueue | null => {
          if (!agent) {
            return null;
          }
          uow.triggerHook("recordAgentChange", { kind: "stopped", agentName, provenance });
          return waitingQueue(changeAgentQueue(uow, agent, true), true, queued);
        })
        .build();
    },
    /**
     * Resumes a paused queue. With nothing dispatched its next turn starts at once; otherwise the
     * stopped turn's settlement starts it. Waiting subagents start up to the limit. Null when the
     * agent has not started.
     */
    resumeAgentQueue: function (input: {
      agentName: string;
      availableModels: readonly PiAvailableModel[];
      provenance: PiAgentTurnProvenance;
    }) {
      const { agentName } = input;
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => findAgentQueue(uow, agentName))
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, dispatched, queued, steered],
          }): { handovers: PiAgentHandover[]; queue: PiAgentWaitingQueue } | null => {
            if (!agent) {
              return null;
            }
            if (!agent.paused) {
              return { handovers: [], queue: waitingQueue(agent.id.version, false, queued) };
            }
            const revision = changeAgentQueue(uow, agent, false);
            uow.triggerHook("recordAgentChange", {
              kind: "resumed",
              agentName,
              provenance: input.provenance,
            });
            const started = startResumedQueue(uow, {
              agent: agentConfig(agentName),
              revision,
              definition: definitionOf(agentName, definitionRow),
              availableModels: input.availableModels,
              dispatched,
              steered,
              queued,
              arrivingSubagent: null,
            });
            return {
              handovers: started.handovers,
              queue: waitingQueue(revision, false, started.waiting),
            };
          },
        )
        .build();
    },
    /**
     * What was handed to Pi and has not settled, to hand over again after a failed handover or a
     * resume. Nothing while the queue is paused: a stop holds back work it did not reach.
     */
    getUnsettledHandovers: function (agentName: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow
            .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
            .find("agent_queue_item", (b) =>
              b
                .whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                  eb.and(eb("agentName", "=", agentName), eb("status", "=", "dispatched")),
                )
                .orderByIndex(AGENT_QUEUE_STATUS_INDEX, "asc"),
            )
            .find("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("status", "=", "steered")),
              ),
            ),
        )
        .transformRetrieve(([agent, dispatched, steered]): PiAgentHandover[] => {
          if (!agent || agent.paused) {
            return [];
          }
          const config = agentConfig(agentName);
          const revision = agent.id.version;
          const handovers = steered.flatMap((item): PiAgentHandover[] => {
            if (item.state.status !== "steered" || !isTurnItem(item)) {
              return [];
            }
            const steer: PiAgentSteer =
              item.input.type === "prompt"
                ? { type: "prompt", requestId: item.requestId, content: item.input.content }
                : { type: "notification", notification: item.input.notification };
            return [{ type: "steer", agent: config, revision, turn: item.state.turn, steer }];
          });
          const subagents = dispatched.filter(isSubagentItem).flatMap((item): PiAgentHandover[] =>
            item.state.status === "dispatched"
              ? [
                  {
                    type: "subagent",
                    agent: config,
                    revision,
                    turn: item.state.turn,
                    prompt: { requestId: item.requestId, content: item.input.content },
                  },
                ]
              : [],
          );
          const [head, ...rest] = dispatched.filter(isRootItem);
          return head?.state.status === "dispatched"
            ? [
                ...handovers,
                ...subagents,
                {
                  type: "dispatch",
                  agent: config,
                  revision,
                  turn: head.state.turn,
                  work: dispatchedWork([head, ...rest]),
                },
              ]
            : [...handovers, ...subagents];
        })
        .build();
    },
    /** The items waiting in an agent's queue, for its conversation's readers. */
    getWaitingQueue: function (agentName: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => findAgentQueue(uow, agentName))
        .transformRetrieve(([, agent, , queued]) =>
          waitingQueue(agent?.id.version ?? 0, agent?.paused ?? false, queued),
        )
        .build();
    },
    /**
     * The agent's latest subagents, newest first, whether they wait, run, or ended, and those still
     * running before them. Subagents start oldest first, so anything newer than one that waits waits
     * too; only running ones can fall behind the latest.
     */
    listSubagents: function (agentName: string, limit: number) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow
            .find("agent_queue_item", (b) =>
              b
                .whereIndex(AGENT_QUEUE_SUBAGENT_INDEX, (eb) =>
                  eb.and(eb("agentName", "=", agentName), eb("subagent", "=", true)),
                )
                .orderByIndex(AGENT_QUEUE_SUBAGENT_INDEX, "desc")
                .pageSize(limit),
            )
            .find("agent_queue_item", (b) =>
              b
                .whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                  eb.and(eb("agentName", "=", agentName), eb("status", "=", "dispatched")),
                )
                .orderByIndex(AGENT_QUEUE_STATUS_INDEX, "desc"),
            ),
        )
        .transformRetrieve(([latest, dispatched]) => {
          const listed = new Set(latest.map(({ requestId }) => requestId));
          const earlier = dispatched.filter(({ requestId }) => !listed.has(requestId));
          return [...latest, ...earlier].filter(isSubagentItem).map(
            (item): PiAgentSubagentItem => ({
              requestId: item.requestId,
              task: item.input.content,
              submittedAt: item.input.submittedAt,
              askingToolCall: item.input.askingToolCall,
              provenance: item.provenance,
              state: item.state,
            }),
          );
        })
        .build();
    },
    /** What the queue knows of a request; null when it never saw the request. */
    getQueueRecord: function (agentName: string, requestId: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow.findFirst("agent_queue_item", (b) =>
            b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
              eb.and(eb("agentName", "=", agentName), eb("requestId", "=", requestId)),
            ),
          ),
        )
        .transformRetrieve(([item]): PiAgentQueueRecord | null => {
          if (!item) {
            return null;
          }
          const { state } = item;
          if (state.status === "queued") {
            return { type: "held", submission: { type: "input", status: "queued", requestId } };
          }
          if (state.status === "dropped") {
            return {
              type: "held",
              submission: { type: "input", status: "dropped", requestId, reason: state.reason },
            };
          }
          // A steer runs under its own request ID; dispatched and settled items name their turn's.
          return {
            type: "turn",
            turnRequestId: state.status === "steered" ? requestId : state.turnRequestId,
          };
        })
        .build();
    },
  });
}
