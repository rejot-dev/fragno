import type {
  AutomationEventState,
  AutomationEventStateDeleteResult,
} from "@fragno-dev/backoffice-api/v0/events";

import type { Cursor, DatabaseHandlerTx, DatabaseServiceContext } from "@fragno-dev/db";

import {
  AutomationEventDefinitionValidationError,
  buildAutomationEventDefinitionId,
} from "./event-definitions";
import type { AutomationInternalHooks, EventStateEntry } from "./internal-hooks";
import { automationFragmentSchema } from "./schema";

/**
 * An event definition's `keyPath` names where its events hold the key of what they are about. Each
 * key's state is a copy of the latest of its events, so the state outlives the events themselves.
 * Ingestion keeps each event it stores in the state. A changed key path, or a deleted definition,
 * leaves the state as it is: each state names the key path its key was read with, and agents delete
 * the states they no longer want.
 */

/** Long enough for ids and paths, short enough to index. */
const MAX_EVENT_KEY_LENGTH = 512;

/** Cursors of `listEventState` name this index. */
export const STATE_INDEX = "idx_automation_event_state_source_type_key";

/** The key at `keyPath` in the payload, or null when there is no string or finite number there. */
function eventKeyAt(payload: unknown, keyPath: string): string | null {
  let value = payload;
  for (const field of keyPath.split(".").slice(1)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    value = (value as Record<string, unknown>)[field];
  }
  const key =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : null;
  return key !== null && key.length > 0 && key.length <= MAX_EVENT_KEY_LENGTH ? key : null;
}

function missingKeyMessage(keyPath: string) {
  return `a string or number of at most ${MAX_EVENT_KEY_LENGTH} characters at its key path ${keyPath}`;
}

/** The key an event is kept under in its type's state, and the key path that read it. */
export type EventStateKey = { key: string; keyPath: string };

/** The key an event of a type with `keyPath` is kept under; an event without one is refused. */
export function requireEventKey(
  event: { source: string; eventType: string; payload: unknown },
  keyPath: string | null,
): EventStateKey | null {
  if (keyPath === null) {
    return null;
  }
  const key = eventKeyAt(event.payload, keyPath);
  if (key === null) {
    throw new AutomationEventDefinitionValidationError(
      `Automation event ${event.source}/${event.eventType} payload needs ${missingKeyMessage(keyPath)}.`,
    );
  }
  return { key, keyPath };
}

/** A definition's example, when it has one, must hold a key wherever its key path says. */
export function assertEventKeyPathFitsExample(definition: {
  keyPath?: string | null;
  example?: unknown;
}) {
  const { keyPath, example } = definition;
  if (!keyPath || example === null || typeof example === "undefined") {
    return;
  }
  if (eventKeyAt(example, keyPath) === null) {
    throw new AutomationEventDefinitionValidationError(
      `The example needs ${missingKeyMessage(keyPath)}.`,
    );
  }
}

/**
 * Whether the event occurred after the one the state holds. Providers deliver late, so the time it
 * occurred decides, and then the time it was stored.
 */
function occurredAfter(
  event: { id: string; occurredAt: Date; createdAt: Date },
  state: { eventId: string; occurredAt: Date; storedAt: Date },
) {
  const order =
    event.occurredAt.getTime() - state.occurredAt.getTime() ||
    event.createdAt.getTime() - state.storedAt.getTime() ||
    event.id.localeCompare(state.eventId);
  return order > 0;
}

/**
 * Keeps one event in its type's state, unless the state of its key holds a later event, whichever
 * key path read that one. An event whose key was read with a key path its type no longer has is
 * left out, as are events stored before the type had one, so a state an agent deleted after the
 * key path changed stays deleted.
 */
export async function keepEventState(
  entry: EventStateEntry,
  handlerTx: DatabaseHandlerTx<AutomationInternalHooks>,
) {
  await handlerTx({ name: "automations.keepEventState" })
    .retrieve(({ forSchema }) =>
      forSchema(automationFragmentSchema)
        .findFirst("automation_event", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", entry.eventId)),
        )
        .findFirst("automation_event_definition", (b) =>
          b.whereIndex("primary", (eb) =>
            eb("id", "=", buildAutomationEventDefinitionId(entry.source, entry.eventType)),
          ),
        )
        .findFirst("automation_event_state", (b) =>
          b.whereIndex(STATE_INDEX, (eb) =>
            eb.and(
              eb("source", "=", entry.source),
              eb("eventType", "=", entry.eventType),
              eb("key", "=", entry.key),
            ),
          ),
        ),
    )
    .mutate(({ forSchema, retrieveResult: [event, definition, state] }) => {
      const uow = forSchema(automationFragmentSchema);
      if (!event || !definition || definition.keyPath !== entry.keyPath) {
        return;
      }
      const stored = { ...event, id: event.id.externalId };
      if (state && !occurredAfter(stored, state)) {
        return;
      }
      // A key path changed since the definition was read must leave this state unwritten, so the
      // write retries after such a change instead of landing after an agent's cleanup.
      uow.check("automation_event_definition", definition.id);
      const values = {
        keyPath: entry.keyPath,
        eventId: stored.id,
        payload: event.payload,
        occurredAt: event.occurredAt,
        storedAt: event.createdAt,
      };
      if (state) {
        uow.update("automation_event_state", state.id, (b) => b.set(values).check());
        return;
      }
      // Two events of a new key race to create its state; the one that retries compares them.
      uow.create(
        "automation_event_state",
        { source: entry.source, eventType: entry.eventType, key: entry.key, ...values },
        { retryOnUniqueConflict: ({ error }) => error.kind === "unique" },
      );
    })
    .execute();
}

function eventStateOfRow(row: {
  key: string;
  keyPath: string;
  eventId: string;
  payload: AutomationEventState["payload"];
  occurredAt: Date;
  storedAt: Date;
}): AutomationEventState {
  return {
    key: row.key,
    keyPath: row.keyPath,
    eventId: row.eventId,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    storedAt: row.storedAt.toISOString(),
  };
}

export const createEventStateServices = (
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<AutomationInternalHooks>>,
  ) => TService,
) =>
  defineService({
    /** A type's states, by key. */
    listEventState(input: { source: string; eventType: string; limit: number; cursor?: Cursor }) {
      const { source, eventType, cursor } = input;
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findWithCursor("automation_event_state", (b) => {
            const query = b
              .whereIndex(STATE_INDEX, (eb) =>
                eb.and(eb("source", "=", source), eb("eventType", "=", eventType)),
              )
              .orderByIndex(STATE_INDEX, "asc")
              .pageSize(cursor?.pageSize ?? input.limit);
            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([page]) => ({
          states: page.items.map(eventStateOfRow),
          cursor: page.cursor,
          hasNextPage: page.hasNextPage,
        }))
        .build();
    },
    /** Deletes the states of a type's keys; the events stay. */
    deleteEventState({
      source,
      eventType,
      keys,
    }: {
      source: string;
      eventType: string;
      keys: readonly string[];
    }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_event_state", (b) =>
            b.whereIndex(STATE_INDEX, (eb) =>
              eb.and(
                eb("source", "=", source),
                eb("eventType", "=", eventType),
                eb("key", "in", [...keys]),
              ),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [states] }): AutomationEventStateDeleteResult => {
          if (states.length > 0) {
            uow.deleteMany(
              "automation_event_state",
              states.map((state) => state.id),
              (b) => b.check(),
            );
          }
          return { deleted: states.map((state) => state.key) };
        })
        .build();
    },
  });
