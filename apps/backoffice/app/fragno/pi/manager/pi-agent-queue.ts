import type { PiAgentConfig, PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { type BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext, HookFn, TypedUnitOfWork } from "@fragno-dev/db";

import {
  admitPiAgentTurn,
  builtInPiAgentDefinition,
  type PiAgentAdmission,
} from "@/fragno/pi/agent/agent-definitions";
import type {
  PiAgent,
  PiAgentNotification,
  PiAgentPrompt,
  PiAgentQueueEntry,
  PiAgentQueueSubmission,
  PiAgentTurn,
  PiAgentWaitingQueue,
  PiAgentWork,
  PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import { piNotificationRequestId } from "@/fragno/pi/agent/pi-agent-notification-entry";
import { mayJoinPiAgentTurn, nextPiAgentQueueTurn } from "@/fragno/pi/agent/pi-agent-queue-rules";

import {
  AGENT_QUEUE_REQUEST_INDEX,
  AGENT_QUEUE_STATUS_INDEX,
  definitionFromRow,
  piAgentDirectorySchema,
  type PiAgentQueueInput,
  type PiAgentQueueItemState,
  type PiAgentTurnProvenance,
} from "./pi-manager-schema";

/** Each hook repeats a handover, in case the request that made it failed. */
export type PiManagerHooks = {
  /** Hands the agent its unsettled items again. */
  redispatchAgentQueue: HookFn<{ agentName: string }>;
  /** Writes notifications that arrived into the conversation again. */
  writeNotificationCards: HookFn<{ agent: PiAgentConfig; notifications: PiAgentNotification[] }>;
};

/**
 * What to hand the agent: a steer that joins its dispatched turn, that turn itself, or the cards
 * of notifications that arrived while their request waits.
 */
export type PiAgentHandover =
  | { type: "steer"; agent: PiAgentConfig; turn: PiAgentTurn; prompt: PiAgentPrompt }
  | { type: "dispatch"; agent: PiAgentConfig; turn: PiAgentTurn; work: PiAgentWork }
  | { type: "write"; agent: PiAgentConfig; notifications: PiAgentNotification[] };

export async function handOverPiAgentWork(
  agents: (config: PiAgentConfig) => PiAgent,
  handover: PiAgentHandover,
): Promise<void> {
  const agent = agents(handover.agent);
  switch (handover.type) {
    case "steer":
      await agent.steer(handover.agent, handover.turn, handover.prompt);
      return;
    case "dispatch":
      await agent.dispatch(handover.agent, handover.turn, handover.work);
      return;
    case "write":
      await agent.writeNotifications(handover.agent, handover.notifications);
      return;
  }
}

export type PiAgentQueueChannel = ReturnType<typeof createPiAgentQueueChannel>;

/** Each agent's waiting items, published as its queue changes to the manager object's streams. */
export function createPiAgentQueueChannel() {
  const latest = new Map<string, PiAgentWaitingQueue>();
  const listeners = new Map<string, Set<(queue: PiAgentWaitingQueue) => void>>();

  // Concurrent requests may publish out of order, so only a newer revision replaces the latest.
  function publish(agentName: string, queue: PiAgentWaitingQueue) {
    const current = latest.get(agentName);
    if (current && current.revision >= queue.revision) {
      return;
    }
    latest.set(agentName, queue);
    for (const listener of listeners.get(agentName) ?? []) {
      listener(queue);
    }
  }

  return {
    publish,
    /**
     * Calls the listener at once with the newer of `read` and the latest publication, then with
     * every newer revision, so a change committed while `read` was taken is not missed.
     */
    watch(
      agentName: string,
      read: PiAgentWaitingQueue,
      listener: (queue: PiAgentWaitingQueue) => void,
    ): () => void {
      publish(agentName, read);
      listener(latest.get(agentName) ?? read);
      const agentListeners = listeners.get(agentName) ?? new Set();
      listeners.set(agentName, agentListeners.add(listener));
      return () => {
        agentListeners.delete(listener);
      };
    },
  };
}

/** `status` repeats the state's tag so the queue's index can find live items. */
function itemState(state: PiAgentQueueItemState) {
  return { status: state.status, state };
}

type PiAgentQueueItem = { requestId: string; input: PiAgentQueueInput };

function queueEntry({ requestId, input }: PiAgentQueueItem): PiAgentQueueEntry {
  return input.type === "prompt"
    ? { type: "prompt", requestId, content: input.content }
    : {
        type: "notification",
        requestId,
        source: input.notification.event.source,
        eventType: input.notification.event.eventType,
      };
}

function waitingQueue(revision: number, paused: boolean, queued: readonly PiAgentQueueItem[]) {
  return { revision, paused, items: queued.map(queueEntry) } satisfies PiAgentWaitingQueue;
}

/** A dispatched turn's work, named by its oldest item, which the queue's rules put first. */
function dispatchedWork(items: readonly [PiAgentQueueItem, ...PiAgentQueueItem[]]): PiAgentWork {
  const [head] = items;
  if (head.input.type === "prompt") {
    return { type: "prompt", requestId: head.requestId, content: head.input.content };
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

/** An agent's definition and provisioning, its dispatched turn, and what waits. */
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
    );
}

/** An item this change records, which has no row yet. */
type PiAgentArrivingItem = PiAgentQueueItem & {
  agentName: string;
  position: number;
  provenance: PiAgentTurnProvenance;
};
type PiAgentQueueRow = PiAgentQueueItem & { id: FragnoId; provenance: PiAgentTurnProvenance };

/**
 * Starts the next turn, which only happens while nothing is dispatched and the queue is not
 * paused: the rules' items are dispatched, or every candidate is dropped when the definition or
 * model they need is gone. Returns what still waits.
 */
function startNextTurn(
  uow: PiAgentQueueUow,
  input: {
    agent: PiAgentConfig;
    definition: PiAgentDefinition | null;
    availableModels: readonly PiAvailableModel[];
    queued: readonly PiAgentQueueRow[];
    arriving: PiAgentArrivingItem | null;
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
    }
    return { handover: null, waiting: [] };
  }
  const turnRequestId = step.items[0].requestId;
  const waiting = candidates.filter((candidate) => !step.items.includes(candidate));
  for (const candidate of step.items) {
    record(candidate, { status: "dispatched", turn: step.turn, turnRequestId });
  }
  for (const candidate of waiting) {
    if (!candidate.id) {
      record(candidate, { status: "queued" });
    }
  }
  uow.triggerHook("redispatchAgentQueue", { agentName: agent.agentName });
  return {
    handover: { type: "dispatch", agent, turn: step.turn, work: dispatchedWork(step.items) },
    waiting,
  };
}

/** Where an admitted item went, what to hand the agent now, and what waits after it. */
type PiAgentPlacement = {
  status: "steered" | "queued";
  handover: PiAgentHandover | null;
  queue: PiAgentWaitingQueue;
};

/**
 * Records an admitted item at the agent's new version: steering the dispatched turn when
 * `steering` is its prompt and the turn's sender sent it, waiting behind the dispatched turn or in
 * a paused queue, or starting the next turn when nothing runs. A notification that waits has its
 * card written at once; only the request to handle it waits.
 */
function placeQueueItem(
  uow: PiAgentQueueUow,
  input: {
    agent: PiAgentConfig;
    revision: number;
    paused: boolean;
    item: PiAgentQueueItem & { provenance: PiAgentTurnProvenance };
    turn: PiAgentTurn;
    steering: PiAgentPrompt | null;
    definition: PiAgentDefinition | null;
    availableModels: readonly PiAvailableModel[];
    dispatched: { state: PiAgentQueueItemState } | undefined;
    queued: readonly PiAgentQueueRow[];
  },
): PiAgentPlacement {
  const { agent, revision, paused, turn, dispatched, queued } = input;
  const { agentName } = agent;
  const arriving = { ...input.item, agentName, position: revision };
  if (
    !paused &&
    input.steering &&
    dispatched?.state.status === "dispatched" &&
    mayJoinPiAgentTurn(dispatched.state.turn, turn)
  ) {
    uow.create("agent_queue_item", { ...arriving, ...itemState({ status: "steered", turn }) });
    uow.triggerHook("redispatchAgentQueue", { agentName });
    return {
      status: "steered",
      handover: { type: "steer", agent, turn, prompt: input.steering },
      queue: waitingQueue(revision, paused, queued),
    };
  }
  if (paused || dispatched) {
    uow.create("agent_queue_item", { ...arriving, ...itemState({ status: "queued" }) });
    const queue = waitingQueue(revision, paused, [...queued, arriving]);
    if (arriving.input.type === "prompt") {
      return { status: "queued", handover: null, queue };
    }
    const notifications = [arriving.input.notification];
    uow.triggerHook("writeNotificationCards", { agent, notifications });
    return { status: "queued", handover: { type: "write", agent, notifications }, queue };
  }
  // Nothing runs, so nothing waits unless the queue was just resumed.
  const started = startNextTurn(uow, {
    agent,
    definition: input.definition,
    availableModels: input.availableModels,
    queued,
    arriving,
  });
  return {
    status: "queued",
    handover: started.handover,
    queue: waitingQueue(revision, paused, started.waiting),
  };
}

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
     * paused queue, which then starts with its oldest item.
     */
    submitPrompt: function (input: {
      agentName: string;
      prompt: PiAgentPrompt;
      whenBusy: "followUp" | "steer" | "reject";
      whenPaused: "wait" | "resume";
      provenance: PiAgentTurnProvenance;
      availableModels: readonly PiAvailableModel[];
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
            retrieveResult: [definitionRow, agent, [dispatched], queued, submitted],
          }):
            | Extract<PiAgentAdmission, { type: "error" }>
            | { type: "busy" }
            | ({ type: "placed" } & PiAgentPlacement) => {
            if (submitted) {
              return {
                type: "placed",
                status: submitted.state.status === "steered" ? "steered" : "queued",
                handover: null,
                queue: waitingQueue(agent?.id.version ?? 0, agent?.paused ?? false, queued),
              };
            }
            const definition = definitionOf(agentName, definitionRow);
            const admitted = admitPiAgentTurn(
              definition,
              agentName,
              input.provenance,
              input.availableModels,
            );
            if (admitted.type === "error") {
              return admitted;
            }
            // A paused queue can hold work with nothing dispatched.
            if (input.whenBusy === "reject" && (dispatched || queued.length > 0)) {
              return { type: "busy" };
            }
            const paused = (agent?.paused ?? false) && input.whenPaused === "wait";
            if (!agent) {
              // A concurrent first prompt may provision the agent first; the retry then finds it.
              uow.create("agent", { id: agentName }, { retryOnUniqueConflict: () => true });
            }
            // A new row starts at version 0.
            const revision = agent ? changeAgentQueue(uow, agent, paused) : 0;
            const placement = placeQueueItem(uow, {
              agent: agentConfig(agentName),
              revision,
              paused,
              item: {
                requestId: prompt.requestId,
                input: { type: "prompt", content: prompt.content },
                provenance: input.provenance,
              },
              turn: admitted.turn,
              // The stopped turn may still be settling, and a steer never joins it.
              steering: input.whenBusy === "steer" && !agent?.paused ? prompt : null,
              definition,
              availableModels: input.availableModels,
              dispatched,
              queued,
            });
            return { type: "placed", ...placement };
          },
        )
        .build();
    },
    /**
     * Admits a notification and places it like a queued prompt. A first prompt provisions the
     * conversation; notifications only address agents already started. Redelivering one event
     * through one route, or to the agent directly, finds the item it placed first.
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
            retrieveResult: [definitionRow, agent, [dispatched], queued, submitted],
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
                handover: null,
                queue: waitingQueue(agent.id.version, agent.paused, queued),
              };
            }
            const definition = definitionOf(agentName, definitionRow);
            const admitted = admitPiAgentTurn(
              definition,
              agentName,
              input.provenance,
              input.availableModels,
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
              },
              turn: admitted.turn,
              steering: null,
              definition,
              availableModels: input.availableModels,
              dispatched,
              queued,
            });
            return { type: "placed", ...placement };
          },
        )
        .build();
    },
    /**
     * Records a settled turn. When it was the dispatched turn, every item it handled settles, and
     * unless the queue is paused the next turn starts. Null when the turn was not the queue's.
     */
    advanceAgentQueue: function (input: {
      agentName: string;
      settledRequestId: string;
      availableModels: readonly PiAvailableModel[];
    }) {
      const { agentName } = input;
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
            retrieveResult: [definitionRow, agent, dispatched, queued, settled],
          }): { handover: PiAgentHandover | null; queue: PiAgentWaitingQueue } | null => {
            if (
              !agent ||
              (settled?.state.status !== "dispatched" && settled?.state.status !== "steered")
            ) {
              return null;
            }
            const revision = changeAgentQueue(uow, agent, agent.paused);
            // A steer settles with the turn it joined, which moves the queue when it settles.
            if (settled.state.status === "steered") {
              uow.update("agent_queue_item", settled.id, (b) =>
                b.set(itemState({ status: "settled", turnRequestId: settled.requestId })),
              );
              return { handover: null, queue: waitingQueue(revision, agent.paused, queued) };
            }
            for (const item of dispatched) {
              if (item.state.status === "dispatched") {
                const { turnRequestId } = item.state;
                uow.update("agent_queue_item", item.id, (b) =>
                  b.set(itemState({ status: "settled", turnRequestId })),
                );
              }
            }
            if (agent.paused) {
              return { handover: null, queue: waitingQueue(revision, true, queued) };
            }
            const started = startNextTurn(uow, {
              agent: agentConfig(agentName),
              definition: definitionOf(agentName, definitionRow),
              availableModels: input.availableModels,
              queued,
              arriving: null,
            });
            return {
              handover: started.handover,
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
    pauseAgentQueue: function (agentName: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => findAgentQueue(uow, agentName))
        .mutate(({ uow, retrieveResult: [, agent, , queued] }): PiAgentWaitingQueue | null =>
          agent ? waitingQueue(changeAgentQueue(uow, agent, true), true, queued) : null,
        )
        .build();
    },
    /**
     * Resumes a paused queue. With nothing dispatched its next turn starts at once; otherwise the
     * stopped turn's settlement starts it. Null when the agent has not started.
     */
    resumeAgentQueue: function (input: {
      agentName: string;
      availableModels: readonly PiAvailableModel[];
    }) {
      const { agentName } = input;
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => findAgentQueue(uow, agentName))
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, dispatched, queued],
          }): { handover: PiAgentHandover | null; queue: PiAgentWaitingQueue } | null => {
            if (!agent) {
              return null;
            }
            if (!agent.paused) {
              return { handover: null, queue: waitingQueue(agent.id.version, false, queued) };
            }
            const revision = changeAgentQueue(uow, agent, false);
            if (dispatched.length > 0) {
              return { handover: null, queue: waitingQueue(revision, false, queued) };
            }
            const started = startNextTurn(uow, {
              agent: agentConfig(agentName),
              definition: definitionOf(agentName, definitionRow),
              availableModels: input.availableModels,
              queued,
              arriving: null,
            });
            return {
              handover: started.handover,
              queue: waitingQueue(revision, false, started.waiting),
            };
          },
        )
        .build();
    },
    /** What was handed to Pi and has not settled, to hand over again after a failed handover. */
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
          if (!agent) {
            return [];
          }
          const config = agentConfig(agentName);
          const handovers = steered.flatMap((item): PiAgentHandover[] =>
            item.state.status === "steered" && item.input.type === "prompt"
              ? [
                  {
                    type: "steer",
                    agent: config,
                    turn: item.state.turn,
                    prompt: { requestId: item.requestId, content: item.input.content },
                  },
                ]
              : [],
          );
          const [head, ...rest] = dispatched;
          return head?.state.status === "dispatched"
            ? [
                ...handovers,
                {
                  type: "dispatch",
                  agent: config,
                  turn: head.state.turn,
                  work: dispatchedWork([head, ...rest]),
                },
              ]
            : handovers;
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
