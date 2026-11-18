import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { decodeCursor, type DatabaseHandlerTx, type DatabaseServiceContext } from "@fragno-dev/db";

import {
  PI_AGENT_KEY_PATH,
  PI_AUTOMATION_SOURCE,
  piAgentActivityByEventType,
  readPiAgentEvent,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import {
  SANDBOX_KEY_PATH,
  SANDBOX_LIFECYCLE_EVENT_TYPES,
} from "@/fragno/backoffice-capabilities/capabilities/sandbox";
import { readIntegrationConnectionStateChange } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  INTEGRATION_CONNECTION_KEY_PATH,
  integrationConnectionEvents,
  isIntegrationConnectionEvent,
  type IntegrationConnectionStatePayload,
} from "@/fragno/runtime-tools/families/integrations/integration-events";

import { occurredAfter, STATE_INDEX, writeEventState } from "./event-state";
import type { AutomationInternalHooks } from "./internal-hooks";
import { rewireProject } from "./project-wiring";
import { automationFragmentSchema, type EventFoldReplayPass } from "./schema";

/**
 * Ingestion keeps `pi` events, `integrations` connection events, and `sandbox` lifecycle events in
 * their states, by the agent, connection, or sandbox they name, but events stored before it did were
 * never kept. The replay reads every
 * stored event of those types, one page per pass, in a chain of `internalReplayEventFold` hooks,
 * and keeps each key's latest. It also reads again the events ingestion kept, which a state
 * compares as any event, so it needs no cutover.
 */

/**
 * The `event_fold_replay` row's ID; its `next` pass is null once the replay read every type. A new
 * ID replays again: this one keeps `pi` and `sandbox` events in their states, which scopes replayed
 * before did not.
 */
export const EVENT_FOLD_REPLAY_ID = "stored-events:agent-state";

/** A stored event's key and the payload its state holds; null for an event no state keeps. */
type ReplayedState = { key: string; payload: Record<string, unknown> } | null;

type StoredEvent = {
  id: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  subject: unknown;
  occurredAt: Date;
  sequence: string | null;
};

/**
 * Events stored before their payloads named their agent take it from their subject. Definitions
 * read as `readPiAgentEvent` completes them, as those of old events lack fields.
 */
function piAgentState(event: StoredEvent): ReplayedState {
  const read = readPiAgentEvent(event);
  if (!read) {
    return null;
  }
  const { agentName } = read;
  return {
    key: agentName,
    payload: {
      ...event.payload,
      agentName,
      ...("definition" in read ? { definition: read.definition } : {}),
    },
  };
}

/** Events stored before their payloads named their connection take it from their subject. */
function connectionState(event: StoredEvent): ReplayedState {
  const change = readIntegrationConnectionStateChange(event);
  if (!change) {
    return null;
  }
  const payload: IntegrationConnectionStatePayload = {
    connectionId: change.connectionId,
    service: change.service,
    ...change.label,
  };
  return { key: change.connectionId, payload };
}

/** Sandbox payloads have always named their sandbox. */
function sandboxState(event: StoredEvent): ReplayedState {
  const { sandboxId } = event.payload;
  return typeof sandboxId === "string" ? { key: sandboxId, payload: event.payload } : null;
}

/**
 * Every type the replay reads, in order, with its key path and its events' states; deleting their
 * events waits for it.
 */
const REPLAYED_TYPES = [
  ...Object.keys(piAgentActivityByEventType).map((eventType) => ({
    source: PI_AUTOMATION_SOURCE,
    eventType,
    keyPath: PI_AGENT_KEY_PATH,
    stateOf: piAgentState,
  })),
  ...integrationConnectionEvents.map(({ source, eventType }) => ({
    source,
    eventType,
    keyPath: INTEGRATION_CONNECTION_KEY_PATH,
    stateOf: connectionState,
  })),
  ...SANDBOX_LIFECYCLE_EVENT_TYPES.map((eventType) => ({
    source: "sandbox",
    eventType,
    keyPath: SANDBOX_KEY_PATH,
    stateOf: sandboxState,
  })),
];

export const REPLAYED_EVENT_TYPES: readonly { source: string; eventType: string }[] =
  REPLAYED_TYPES.map(({ source, eventType }) => ({ source, eventType }));

const EVENTS_OF_TYPE_INDEX = "idx_automation_event_source_type_occurredAt";

/** Events replayed in one transaction, bounding the states one pass reads and writes. */
const EVENTS_REPLAYED_PER_PASS = 50;

function replayedTypeOf(pass: Pick<EventFoldReplayPass, "source" | "eventType">) {
  return REPLAYED_TYPES.findIndex(
    ({ source, eventType }) => source === pass.source && eventType === pass.eventType,
  );
}

function firstPassOfType(typeIndex: number): EventFoldReplayPass | null {
  const type = REPLAYED_TYPES[typeIndex];
  return type ? { source: type.source, eventType: type.eventType, cursor: null } : null;
}

/** The type's next page, or else the next type's first. */
function passAfter(pass: EventFoldReplayPass, cursor: string | null) {
  if (cursor !== null) {
    return { ...pass, cursor };
  }
  return firstPassOfType(replayedTypeOf(pass) + 1);
}

function samePass(stored: EventFoldReplayPass | null, pass: EventFoldReplayPass) {
  return (
    stored !== null &&
    stored.source === pass.source &&
    stored.eventType === pass.eventType &&
    stored.cursor === pass.cursor
  );
}

/** Of a page of one type's events, each key's latest, with the payload its state holds. */
function latestStates(
  events: readonly (StoredEvent & { createdAt: Date })[],
  stateOf: (event: StoredEvent) => ReplayedState,
) {
  const latest = new Map<
    string,
    {
      id: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
      sequence: string | null;
      createdAt: Date;
    }
  >();
  for (const event of events) {
    const state = stateOf(event);
    const kept = state && latest.get(state.key);
    if (
      state &&
      (!kept ||
        occurredAfter(event, {
          eventId: kept.id,
          occurredAt: kept.occurredAt,
          sequence: kept.sequence,
          storedAt: kept.createdAt,
        }))
    ) {
      latest.set(state.key, {
        id: event.id,
        payload: state.payload,
        occurredAt: event.occurredAt,
        sequence: event.sequence,
        createdAt: event.createdAt,
      });
    }
  }
  return latest;
}

/**
 * Keeps the pass's page in its states and queues the next pass. The replay row names the pass it
 * expects, and moves on with the page's states, so a hook that runs again after its page committed
 * does nothing.
 * Types with no events left are passed over in the same run, so a scope with few events finishes
 * in few.
 */
export async function replayEventFold(
  pass: EventFoldReplayPass,
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>,
  ownerScope: BackofficeContextScope,
) {
  let current = pass;
  for (;;) {
    const { replay, events, cursor } = await handlerTx({ name: "automations.replayEventFold" })
      .retrieve(({ forSchema }) =>
        forSchema(automationFragmentSchema)
          .findFirst("event_fold_replay", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", EVENT_FOLD_REPLAY_ID)),
          )
          .findWithCursor("automation_event", (b) => {
            const query = b
              .whereIndex(EVENTS_OF_TYPE_INDEX, (eb) =>
                eb.and(eb("source", "=", current.source), eb("eventType", "=", current.eventType)),
              )
              .orderByIndex(EVENTS_OF_TYPE_INDEX, "asc")
              .pageSize(EVENTS_REPLAYED_PER_PASS);
            return current.cursor === null ? query : query.after(decodeCursor(current.cursor));
          }),
      )
      .transformRetrieve(([replay, page]) => ({
        replay,
        events: page.items,
        cursor: page.hasNextPage && page.cursor ? page.cursor.encode() : null,
      }))
      .execute();
    if (!replay || !samePass(replay.next, pass)) {
      return;
    }
    const next = passAfter(current, cursor);
    if (events.length === 0 && next !== null) {
      current = next;
      continue;
    }

    const { keyPath, stateOf } = REPLAYED_TYPES[replayedTypeOf(current)];
    const latest = latestStates(
      events.map((event) => ({
        ...event,
        id: event.id.externalId,
        subject: event.subject ?? null,
      })),
      stateOf,
    );
    await handlerTx({ name: "automations.replayEventFold" })
      .retrieve(({ forSchema }) =>
        forSchema(automationFragmentSchema).find("automation_event_state", (b) =>
          b.whereIndex(STATE_INDEX, (eb) =>
            eb.and(
              eb("source", "=", current.source),
              eb("eventType", "=", current.eventType),
              eb("key", "in", [...latest.keys()]),
            ),
          ),
        ),
      )
      .mutate(({ forSchema, retrieveResult: [stateRows] }) => {
        const uow = forSchema(automationFragmentSchema);
        const states = new Map(stateRows.map((state) => [state.key, state]));
        for (const [key, event] of latest) {
          writeEventState(uow, { ...current, key, keyPath }, event, states.get(key) ?? null);
        }
        // A project's connections are part of its wiring, read from these states.
        if (latest.size > 0 && isIntegrationConnectionEvent(current)) {
          rewireProject(uow, ownerScope);
        }
        uow.update("event_fold_replay", replay.id, (b) => b.set({ next }).check());
        if (next !== null) {
          uow.triggerHook("internalReplayEventFold", next);
        }
      })
      .execute();
    return;
  }
}

export const createEventFoldReplayServices = (
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<AutomationInternalHooks>>,
  ) => TService,
) =>
  defineService({
    /** Starts the replay unless it started before. The object asks each time it starts. */
    startEventFoldReplay() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("event_fold_replay", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", EVENT_FOLD_REPLAY_ID)),
          ),
        )
        .mutate(({ uow, retrieveResult: [replay] }) => {
          const first = firstPassOfType(0);
          if (replay || first === null) {
            return;
          }
          // Two starts of the object can race; the one that retries finds the replay started.
          uow.create(
            "event_fold_replay",
            { id: EVENT_FOLD_REPLAY_ID, next: first },
            { retryOnUniqueConflict: () => true },
          );
          uow.triggerHook("internalReplayEventFold", first);
        })
        .build();
    },
  });
