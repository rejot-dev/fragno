import { decodeCursor, type DatabaseHandlerTx, type DatabaseServiceContext } from "@fragno-dev/db";

import {
  readIntegrationConnectionStateChange,
  type IntegrationConnectionStateChange,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  INTEGRATION_CONNECTION_KEY_PATH,
  integrationConnectionEvents,
  type IntegrationConnectionStatePayload,
} from "@/fragno/runtime-tools/families/integrations/integration-events";

import {
  FOLDED_EVENT_TYPES,
  foldProjectedEvents,
  projectedEventKeys,
  projectedEventOf,
} from "./event-projections";
import { occurredAfter, STATE_INDEX, writeEventState } from "./event-state";
import type { AutomationInternalHooks } from "./internal-hooks";
import { automationFragmentSchema, type EventFoldReplayPass } from "./schema";

/**
 * Ingestion folds `pi` events into agents as it stores them, and keeps `integrations` connection
 * events in their states, but events stored before it did were never folded or kept. The replay
 * reads every stored event of those types, one page per pass, in a chain of
 * `internalReplayEventFold` hooks. It also reads again the events ingestion handled, which changes
 * nothing but ties (see `foldProjectedEvents`), so it needs no cutover.
 */

/**
 * The `event_fold_replay` row's ID; its `next` pass is null once the replay read every type. A new
 * ID replays again: this one keeps connection events in their states, which scopes replayed before
 * did not.
 */
export const EVENT_FOLD_REPLAY_ID = "stored-events:connection-state";

/** Every type the replay reads, in order; deleting their events waits for it. */
export const REPLAYED_EVENT_TYPES: readonly { source: string; eventType: string }[] = [
  ...FOLDED_EVENT_TYPES,
  ...integrationConnectionEvents.map(({ source, eventType }) => ({ source, eventType })),
];

const EVENTS_OF_TYPE_INDEX = "idx_automation_event_source_type_occurredAt";

/** A page's rows are read in one `in` list per table, which stays well below SQLite's limits. */
const EVENTS_REPLAYED_PER_PASS = 100;

function firstPassOfType(typeIndex: number): EventFoldReplayPass | null {
  const type = REPLAYED_EVENT_TYPES[typeIndex];
  return type ? { ...type, cursor: null } : null;
}

/** The type's next page, or else the next type's first. */
function passAfter(pass: EventFoldReplayPass, cursor: string | null) {
  if (cursor !== null) {
    return { ...pass, cursor };
  }
  return firstPassOfType(
    REPLAYED_EVENT_TYPES.findIndex(
      ({ source, eventType }) => source === pass.source && eventType === pass.eventType,
    ) + 1,
  );
}

function samePass(stored: EventFoldReplayPass | null, pass: EventFoldReplayPass) {
  return (
    stored !== null &&
    stored.source === pass.source &&
    stored.eventType === pass.eventType &&
    stored.cursor === pass.cursor
  );
}

/** Of a page of one type's events, each connection's latest change; empty for other types. */
function latestConnectionChanges(
  events: readonly (Parameters<typeof readIntegrationConnectionStateChange>[0] & {
    createdAt: Date;
  })[],
) {
  const latest = new Map<string, { change: IntegrationConnectionStateChange; createdAt: Date }>();
  for (const event of events) {
    const change = readIntegrationConnectionStateChange(event);
    const kept = change && latest.get(change.connectionId);
    if (change && (!kept || occurredAfter(event, { ...kept.change, storedAt: kept.createdAt }))) {
      latest.set(change.connectionId, { change, createdAt: event.createdAt });
    }
  }
  return latest;
}

/**
 * What the change's state holds. Events stored before their payloads named the connection take it
 * from their subject.
 */
function connectionStatePayload(
  change: IntegrationConnectionStateChange,
): IntegrationConnectionStatePayload {
  return { connectionId: change.connectionId, service: change.service, ...change.label };
}

/**
 * Folds the pass's page and queues the next pass. The replay row names the pass it expects, and
 * moves on with the page's fold, so a hook that runs again after its page committed does nothing.
 * Types with no events left are passed over in the same run, so a scope with few events finishes
 * in few.
 */
export async function replayEventFold(
  pass: EventFoldReplayPass,
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>,
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

    const stored = events.map((event) => ({
      ...event,
      id: event.id.externalId,
      subject: event.subject ?? null,
    }));
    const projected = stored.map(projectedEventOf);
    const keys = projectedEventKeys(projected);
    const connections = latestConnectionChanges(stored);
    await handlerTx({ name: "automations.replayEventFold" })
      .retrieve(({ forSchema }) =>
        forSchema(automationFragmentSchema)
          .find("pi_agent", (b) => b.whereIndex("primary", (eb) => eb("id", "in", keys.agents)))
          .find("pi_agent_request", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", keys.requests)),
          )
          .find("automation_event_state", (b) =>
            b.whereIndex(STATE_INDEX, (eb) =>
              eb.and(
                eb("source", "=", current.source),
                eb("eventType", "=", current.eventType),
                eb("key", "in", [...connections.keys()]),
              ),
            ),
          ),
      )
      .mutate(({ forSchema, retrieveResult: [agentRows, requestRows, stateRows] }) => {
        const uow = forSchema(automationFragmentSchema);
        foldProjectedEvents(uow, projected, { agentRows, requestRows });
        const states = new Map(stateRows.map((state) => [state.key, state]));
        for (const [key, { change, createdAt }] of connections) {
          writeEventState(
            uow,
            { ...current, key, keyPath: INTEGRATION_CONNECTION_KEY_PATH },
            {
              id: change.eventId,
              payload: connectionStatePayload(change),
              occurredAt: change.occurredAt,
              createdAt,
            },
            states.get(key) ?? null,
          );
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
