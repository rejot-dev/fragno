import {
  type AutomationEvent,
  automationEventDetailSchema,
  automationEventRouteDispatchSchema,
  type AutomationEventRecord,
  automationEventListInputSchema,
  automationEventListResultSchema,
  automationEventRoutesListInputSchema,
  automationEventRoutesListResultSchema,
} from "@fragno-dev/backoffice-api/v0/events";
import { getFragmentDurableHooks } from "@fragno-dev/db/durable-hooks";

import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";

import { automationFragmentDefinition } from "./definition";
import { EVENTS_BY_TIME_INDEX } from "./events-storage-runtime";
import {
  eventRouteDispatchesOfRows,
  ROUTES_BY_STATUS_INDEX,
} from "./route-dispatches-storage-runtime";

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
  ({ defineRoute, services, deps }) => [
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
      method: "POST",
      path: "/events/:eventId/routes/:routeId/retry",
      outputSchema: automationEventRouteDispatchSchema,
      errorCodes: ["ROUTE_DISPATCH_NOT_FOUND", "ROUTE_DISPATCH_NOT_FAILED"],
      handler: async function ({ pathParams }, { json, error }) {
        const { namespace, hookService } = getFragmentDurableHooks(deps);
        const retry = await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                services.retryRouteDispatch({
                  ...pathParams,
                  retryHook: (hookId) => hookService.retryFailedHook(namespace, hookId),
                }),
              ] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        switch (retry.status) {
          case "retried":
            return json(retry.route);
          case "not_found":
            return error(
              {
                message: "Automation event has no route dispatch to retry for this route.",
                code: "ROUTE_DISPATCH_NOT_FOUND",
              },
              404,
            );
          case "not_failed":
            return error(
              {
                message: "Only a route that failed for good can be retried.",
                code: "ROUTE_DISPATCH_NOT_FAILED",
              },
              409,
            );
        }
        throw new Error("Unsupported automation route retry status.");
      },
    }),
    defineRoute({
      method: "GET",
      path: "/event-routes",
      queryParameters: ["status", "limit", "cursor"],
      outputSchema: automationEventRoutesListResultSchema,
      errorCodes: ["EVENT_ROUTES_LIST_INPUT_INVALID"],
      handler: async function ({ query }, { json, error }) {
        const limitRaw = query.get("limit")?.trim();
        const parsed = automationEventRoutesListInputSchema.safeParse({
          status: query.get("status")?.trim(),
          limit: limitRaw ? Number(limitRaw) : undefined,
        });
        const cursorRaw = query.get("cursor")?.trim();
        let cursor;
        try {
          cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;
        } catch {
          cursor = null;
        }
        if (
          !parsed.success ||
          cursor === null ||
          (cursor &&
            (cursor.indexName !== ROUTES_BY_STATUS_INDEX ||
              cursor.orderDirection !== "desc" ||
              cursor.pageSize <= 0 ||
              cursor.pageSize > 500))
        ) {
          return error(
            {
              message:
                "Event routes list needs a status of pending, retrying, completed, or failed, a limit of 1 to 500, and a cursor from a previous page.",
              code: "EVENT_ROUTES_LIST_INPUT_INVALID",
            },
            400,
          );
        }

        const result = await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                services.listRoutesWithStatus({
                  status: parsed.data.status,
                  limit: parsed.data.limit ?? 100,
                  cursor,
                }),
              ] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json({
          routes: result.routes,
          nextCursor: result.cursor?.encode(),
          hasNextPage: result.hasNextPage,
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
            (cursor.indexName !== EVENTS_BY_TIME_INDEX ||
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
          events: result.events.map((event) => ({
            ...automationEventRecord(event),
            routing: event.routesMatched
              ? { status: "matched" as const, routes: eventRouteDispatchesOfRows(event.routes) }
              : { status: "matching" as const },
          })),
          nextCursor: result.cursor?.encode(),
          hasNextPage: result.hasNextPage,
        });
      },
    }),
  ],
);
