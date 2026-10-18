import type { PiAgentConfig, PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import {
  type BackofficeContextScope,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext, HookFn, TypedUnitOfWork } from "@fragno-dev/db";

import {
  admitPiAgentTurn,
  builtInPiAgentDefinition,
  type PiAgentAdmission,
} from "@/fragno/pi/agent/agent-definitions";
import type {
  PiAgentPrompt,
  PiAgentQueueSubmission,
  PiAgentTurn,
  PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import { mayJoinPiAgentTurn } from "@/fragno/pi/agent/pi-agent-turns";

import {
  AGENT_QUEUE_REQUEST_INDEX,
  AGENT_QUEUE_STATUS_INDEX,
  definitionFromRow,
  piAgentDirectorySchema,
  type PiAgentQueueItemState,
  type PiAgentTurnProvenance,
} from "./pi-manager-schema";

export type PiManagerHooks = {
  /** Hands the agent its unsettled items again, in case the request that handed them over failed. */
  redispatchAgentQueue: HookFn<{ agentName: string }>;
};

/** An item to hand to the agent, with the turn it was admitted as. */
export type PiAgentDispatch = { agent: PiAgentConfig; turn: PiAgentTurn; prompt: PiAgentPrompt };

/** `status` repeats the state's tag so the queue's index can find live items. */
function itemState(state: PiAgentQueueItemState) {
  return { status: state.status, state };
}

type PiAgentQueueUow = TypedUnitOfWork<typeof piAgentDirectorySchema, [], unknown, PiManagerHooks>;

/**
 * Every change to an agent's queue updates its row, so concurrent changes to one queue conflict and
 * retry. Returns the row's new version, which orders items.
 */
function changeAgentQueue(uow: PiAgentQueueUow, agent: { id: FragnoId }) {
  uow.update("agent", agent.id, (b) => b.set({}).check());
  return agent.id.version + 1;
}

/**
 * With nothing dispatched, the queue's head runs. Admission depends on the agent's definition and
 * models alone, so a head that cannot be admitted means nothing waiting can run.
 */
function nextPiAgentQueueStep<TItem extends { provenance: PiAgentTurnProvenance }>(
  queued: readonly TItem[],
  definition: PiAgentDefinition | null,
  agentName: string,
  availableModels: readonly PiAvailableModel[],
):
  | { type: "idle" }
  | { type: "dispatch"; item: TItem; turn: PiAgentTurn }
  | { type: "drop"; reason: string } {
  const [head] = queued;
  if (!head) {
    return { type: "idle" };
  }
  const admitted = admitPiAgentTurn(definition, agentName, head.provenance, availableModels);
  return admitted.type === "turn"
    ? { type: "dispatch", item: head, turn: admitted.turn }
    : { type: "drop", reason: admitted.message };
}

/** How the queue took a prompt; `dispatch` is what to hand the agent now, if anything. */
type PiPromptSubmission =
  | Extract<PiAgentAdmission, { type: "error" }>
  | { type: "billing-owner-required" }
  | { type: "busy" }
  | { type: "steered"; dispatch: PiAgentDispatch | null }
  | { type: "queued"; dispatch: PiAgentDispatch | null };

/** Each agent's queue: the items waiting for a turn, the one Pi runs, and the ones that ended. */
export function piAgentQueueServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<PiManagerHooks>>,
  ) => TService,
  config: { scope: BackofficeContextScope },
) {
  function agentConfig(agentName: string, billingOrganizationId: string | null): PiAgentConfig {
    return { scope: config.scope, agentName, billingOrganizationId };
  }

  return defineService({
    /**
     * Admits a prompt and places it: steering the dispatched turn when it has the same authority,
     * otherwise queued, and dispatched at once when nothing else runs. The first prompt provisions
     * the agent. A request ID the queue has seen keeps its first placement and never runs twice.
     */
    submitPrompt: function (input: {
      agentName: string;
      prompt: PiAgentPrompt;
      whenBusy: "followUp" | "steer" | "reject";
      provenance: PiAgentTurnProvenance;
      billingOrganizationId: string | null;
      availableModels: readonly PiAvailableModel[];
    }) {
      const { agentName, prompt } = input;
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow
            .findFirst("agent_definition", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", agentName)),
            )
            .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
            .findFirst("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("requestId", "=", prompt.requestId)),
              ),
            )
            .findFirst("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("status", "=", "dispatched")),
              ),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, submitted, dispatched],
          }): PiPromptSubmission => {
            if (submitted) {
              return {
                type: submitted.state.status === "steered" ? "steered" : "queued",
                dispatch: null,
              };
            }
            const admitted = admitPiAgentTurn(
              builtInPiAgentDefinition(agentName) ??
                (definitionRow ? definitionFromRow(definitionRow) : null),
              agentName,
              input.provenance,
              input.availableModels,
            );
            if (admitted.type === "error") {
              return admitted;
            }
            // Work a user answers for has no organization to bill unless the user picks one.
            if (
              !agent &&
              backofficeScopeRootOwner(config.scope)?.kind === "user" &&
              input.billingOrganizationId === null
            ) {
              return { type: "billing-owner-required" };
            }
            // Items wait only behind a dispatched one, so it alone says whether the agent is busy.
            if (input.whenBusy === "reject" && dispatched) {
              return { type: "busy" };
            }
            const billingOrganizationId = agent
              ? agent.billingOrganizationId
              : input.billingOrganizationId;
            if (!agent) {
              // A concurrent first prompt may provision the agent first; the retry then finds it.
              uow.create(
                "agent",
                { id: agentName, billingOrganizationId },
                { retryOnUniqueConflict: () => true },
              );
            }
            // A new row starts at version 0.
            const revision = agent ? changeAgentQueue(uow, agent) : 0;
            const item = {
              agentName,
              position: revision,
              requestId: prompt.requestId,
              input: { type: "prompt" as const, content: prompt.content },
              provenance: input.provenance,
            };
            const dispatch = {
              agent: agentConfig(agentName, billingOrganizationId),
              turn: admitted.turn,
              prompt,
            };
            if (
              input.whenBusy === "steer" &&
              dispatched?.state.status === "dispatched" &&
              mayJoinPiAgentTurn(dispatched.state.turn, admitted.turn)
            ) {
              uow.create("agent_queue_item", {
                ...item,
                ...itemState({ status: "steered", turn: admitted.turn }),
              });
              uow.triggerHook("redispatchAgentQueue", { agentName });
              return { type: "steered", dispatch };
            }
            if (dispatched) {
              uow.create("agent_queue_item", { ...item, ...itemState({ status: "queued" }) });
              return { type: "queued", dispatch: null };
            }
            uow.create("agent_queue_item", {
              ...item,
              ...itemState({ status: "dispatched", turn: admitted.turn }),
            });
            uow.triggerHook("redispatchAgentQueue", { agentName });
            return { type: "queued", dispatch };
          },
        )
        .build();
    },
    /**
     * Records a settled turn and, once nothing is dispatched, dispatches the next item or drops
     * every waiting one that cannot run. Returns the newly dispatched item.
     */
    advanceAgentQueue: function (input: {
      agentName: string;
      settledRequestId: string;
      availableModels: readonly PiAvailableModel[];
    }) {
      const { agentName } = input;
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow
            .findFirst("agent_definition", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", agentName)),
            )
            .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
            .findFirst("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
                eb.and(
                  eb("agentName", "=", agentName),
                  eb("requestId", "=", input.settledRequestId),
                ),
              ),
            )
            .findFirst("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("status", "=", "dispatched")),
              ),
            )
            .find("agent_queue_item", (b) =>
              b
                .whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                  eb.and(eb("agentName", "=", agentName), eb("status", "=", "queued")),
                )
                .orderByIndex(AGENT_QUEUE_STATUS_INDEX, "asc"),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [definitionRow, agent, settled, dispatched, queued],
          }): PiAgentDispatch | null => {
            // Turns the queue never placed, such as notifications, settle without changing it.
            if (
              !agent ||
              (settled?.state.status !== "dispatched" && settled?.state.status !== "steered")
            ) {
              return null;
            }
            changeAgentQueue(uow, agent);
            uow.update("agent_queue_item", settled.id, (b) =>
              b.set(itemState({ status: "settled" })),
            );
            if (dispatched && dispatched.requestId !== settled.requestId) {
              return null;
            }
            const step = nextPiAgentQueueStep(
              queued,
              builtInPiAgentDefinition(agentName) ??
                (definitionRow ? definitionFromRow(definitionRow) : null),
              agentName,
              input.availableModels,
            );
            if (step.type === "drop") {
              // The definition or model they need went away while they waited.
              for (const item of queued) {
                uow.update("agent_queue_item", item.id, (b) =>
                  b.set(itemState({ status: "dropped", reason: step.reason })),
                );
              }
            }
            if (step.type !== "dispatch") {
              return null;
            }
            uow.update("agent_queue_item", step.item.id, (b) =>
              b.set(itemState({ status: "dispatched", turn: step.turn })),
            );
            uow.triggerHook("redispatchAgentQueue", { agentName });
            return {
              agent: agentConfig(agentName, agent.billingOrganizationId),
              turn: step.turn,
              prompt: { requestId: step.item.requestId, content: step.item.input.content },
            };
          },
        )
        .build();
    },
    /** Items handed to Pi that have not settled, to hand over again after a failed handover. */
    getUnsettledQueueItems: function (agentName: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow
            .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
            .findFirst("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("status", "=", "dispatched")),
              ),
            )
            .find("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("status", "=", "steered")),
              ),
            ),
        )
        .transformRetrieve(([agent, dispatched, steered]) => {
          if (!agent) {
            return { dispatched: null, steered: [] };
          }
          const config = agentConfig(agentName, agent.billingOrganizationId);
          return {
            dispatched:
              dispatched?.state.status === "dispatched"
                ? {
                    agent: config,
                    turn: dispatched.state.turn,
                    prompt: { requestId: dispatched.requestId, content: dispatched.input.content },
                  }
                : null,
            steered: steered.flatMap((item): PiAgentDispatch[] =>
              item.state.status === "steered"
                ? [
                    {
                      agent: config,
                      turn: item.state.turn,
                      prompt: { requestId: item.requestId, content: item.input.content },
                    },
                  ]
                : [],
            ),
          };
        })
        .build();
    },
    /** Aborting an agent drops what waits for it; Pi withdraws what it already holds. */
    dropWaitingQueueItems: function (agentName: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow
            .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName)))
            .find("agent_queue_item", (b) =>
              b.whereIndex(AGENT_QUEUE_STATUS_INDEX, (eb) =>
                eb.and(eb("agentName", "=", agentName), eb("status", "=", "queued")),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [agent, queued] }) => {
          if (!agent || queued.length === 0) {
            return;
          }
          changeAgentQueue(uow, agent);
          for (const item of queued) {
            uow.update("agent_queue_item", item.id, (b) =>
              b.set(
                itemState({
                  status: "dropped",
                  reason: "The agent was aborted before this prompt ran.",
                }),
              ),
            );
          }
        })
        .build();
    },
    /**
     * What a prompt's submission reads while the manager holds it. Null once Pi holds it, or when
     * the queue never saw the request.
     */
    getQueueSubmission: function (agentName: string, requestId: string) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow.findFirst("agent_queue_item", (b) =>
            b.whereIndex(AGENT_QUEUE_REQUEST_INDEX, (eb) =>
              eb.and(eb("agentName", "=", agentName), eb("requestId", "=", requestId)),
            ),
          ),
        )
        .transformRetrieve(([item]): PiAgentQueueSubmission | null => {
          if (item?.state.status === "dropped") {
            return { type: "input", status: "dropped", requestId, reason: item.state.reason };
          }
          // A dispatched item reads as queued until Pi has its submission.
          return item?.state.status === "queued" || item?.state.status === "dispatched"
            ? { type: "input", status: "queued", requestId }
            : null;
        })
        .build();
    },
  });
}
