import {
  type AutomationEvent,
  automationEventDetailSchema,
  type AutomationEventRecord,
  automationEventListInputSchema,
  automationEventListResultSchema,
} from "@fragno-dev/backoffice-api/v0/events";

import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";

import { automationFragmentDefinition } from "./definition";

type AutomationEventRow = Omit<AutomationEvent, "id" | "occurredAt" | "causation"> & {
  id: { valueOf(): string };
  occurredAt: Date;
  causation: AutomationEvent["causation"] | null;
  createdAt: Date;
};

/** Stored events always have a creation time; the public record leaves it optional. */
export function automationEventRecord(
  event: AutomationEventRow,
): AutomationEventRecord & { createdAt: string } {
  return {
    id: event.id.valueOf(),
    scope: event.scope,
    scopeRestriction: event.scopeRestriction,
    source: event.source,
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
    actors: event.actors,
    subject: event.subject ?? null,
    // Events recorded before causation was tracked read as origins.
    causation: event.causation ?? { kind: "origin" },
    createdAt: event.createdAt.toISOString(),
  };
}

export const automationEventRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "GET",
      path: "/events/:eventId",
      outputSchema: automationEventDetailSchema,
      handler: async function ({ pathParams }, { json, error }) {
        const { eventId } = pathParams;
        const [event, routes] = await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                services.getEvent({ id: eventId }),
                services.listEventRouteDispatches({ eventId }),
              ] as const,
          )
          .transform(({ serviceResult }) => serviceResult)
          .execute();

        if (!event) {
          return error({ message: "Automation event not found.", code: "EVENT_NOT_FOUND" }, 404);
        }

        return json({
          ...automationEventRecord(event),
          routing: event.routesMatched ? { status: "matched", routes } : { status: "matching" },
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/events",
      queryParameters: ["limit", "cursor"],
      outputSchema: automationEventListResultSchema,
      handler: async function ({ query }, { json, error }) {
        const limitRaw = query.get("limit")?.trim();
        const limit = limitRaw ? Number(limitRaw) : undefined;

        if (
          limitRaw &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 500)
        ) {
          return error(
            {
              message: "Events list limit must be a positive integer no greater than 500.",
              code: "EVENTS_LIST_LIMIT_INVALID",
            },
            400,
          );
        }

        const parsed = automationEventListInputSchema.safeParse({ limit });
        if (!parsed.success) {
          return error(
            {
              message: "Invalid events list input.",
              code: "EVENTS_LIST_INPUT_INVALID",
            },
            400,
          );
        }

        const cursorRaw = query.get("cursor")?.trim();
        let cursor;
        try {
          cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;
          if (
            cursor &&
            (cursor.indexName !== "idx_automation_event_occurredAt_id" ||
              cursor.orderDirection !== "desc" ||
              cursor.pageSize <= 0 ||
              cursor.pageSize > 500)
          ) {
            throw new Error("Cursor is not valid for automation events.");
          }
        } catch {
          return error(
            {
              message: "Invalid events list cursor.",
              code: "EVENTS_LIST_CURSOR_INVALID",
            },
            400,
          );
        }

        const result = await this.handlerTx()
          .withServiceCalls(() => [services.listEvents({ ...parsed.data, cursor })] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json({
          events: result.events.map(automationEventRecord),
          nextCursor: result.cursor?.encode(),
          hasNextPage: result.hasNextPage,
        });
      },
    }),
  ],
);
