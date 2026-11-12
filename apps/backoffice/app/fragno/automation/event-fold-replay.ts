import { decodeCursor, type DatabaseHandlerTx, type DatabaseServiceContext } from "@fragno-dev/db";

import {
  FOLDED_EVENT_TYPES,
  foldProjectedEvents,
  projectedEventKeys,
  projectedEventOf,
} from "./event-projections";
import type { AutomationInternalHooks } from "./internal-hooks";
import { automationFragmentSchema, type EventFoldReplayPass } from "./schema";

/**
 * Ingestion folds `pi` and `integrations` events into agents and connections as it stores them,
 * but events stored before it did were never folded. The replay folds every stored event of the
 * types the fold reads, one page per pass, in a chain of `internalReplayEventFold` hooks. It also
 * folds again the events ingestion folded, which changes nothing but ties (see
 * `foldProjectedEvents`), so it needs no cutover.
 */

/** The `event_fold_replay` row's ID; its `next` pass is null once the replay folded every type. */
export const EVENT_FOLD_REPLAY_ID = "stored-events";

const EVENTS_OF_TYPE_INDEX = "idx_automation_event_source_type_occurredAt";

/** A page's rows are read in one `in` list per table, which stays well below SQLite's limits. */
const EVENTS_REPLAYED_PER_PASS = 100;

function firstPassOfType(typeIndex: number): EventFoldReplayPass | null {
  const type = FOLDED_EVENT_TYPES[typeIndex];
  return type ? { ...type, cursor: null } : null;
}

/** The type's next page, or else the next type's first. */
function passAfter(pass: EventFoldReplayPass, cursor: string | null) {
  if (cursor !== null) {
    return { ...pass, cursor };
  }
  return firstPassOfType(
    FOLDED_EVENT_TYPES.findIndex(
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

    const projected = events.map((event) =>
      projectedEventOf({ ...event, id: event.id.externalId, subject: event.subject ?? null }),
    );
    const keys = projectedEventKeys(projected);
    await handlerTx({ name: "automations.replayEventFold" })
      .retrieve(({ forSchema }) =>
        forSchema(automationFragmentSchema)
          .find("pi_agent", (b) => b.whereIndex("primary", (eb) => eb("id", "in", keys.agents)))
          .find("pi_agent_request", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", keys.requests)),
          )
          .find("integration_connection", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", keys.connections)),
          ),
      )
      .mutate(({ forSchema, retrieveResult: [agentRows, requestRows, connectionRows] }) => {
        const uow = forSchema(automationFragmentSchema);
        foldProjectedEvents(uow, projected, { agentRows, requestRows, connectionRows });
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
