import type { EventListInput } from "@fragno-dev/backoffice-api/v0/events";
import {
  type AutomationEventDetail,
  type AutomationEventRoutesListInput,
  type AutomationEventRoutesListResult,
  automationEventListResultSchema,
  type AutomationEventRouteDispatch,
} from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { EventEmitArgs } from "@/fragno/runtime-tools/automation-types";
import {
  defineCliArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
};

/** Stored event reads and emission are restricted to the runtime's execution scope. */
export type EventRuntime = {
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
  listEvents(input: EventListInput): Promise<z.infer<typeof automationEventListResultSchema>>;
  listEventRoutes(input: AutomationEventRoutesListInput): Promise<AutomationEventRoutesListResult>;
  getEvent(input: { id: string }): Promise<AutomationEventDetail | null>;
  retryEventRoute(input: {
    eventId: string;
    routeId: string;
  }): Promise<AutomationEventRouteDispatch | null>;
};

type EventToolContext = BackofficeToolContext<{ event?: EventRuntime }>;

const getEventRuntime = (runtime: EventToolContext["runtimes"]["event"]): EventRuntime => {
  if (!runtime) {
    throw new Error("Events runtime is not available in this execution context");
  }
  return runtime;
};

const parseEventFireArgs = defineCliArgsParser<EventEmitArgs>("events.fire", {
  eventType: { required: true },
  source: {},
  subjectUserId: {},
  payload: { kind: "json", option: "payload-json" },
  targetScope: { kind: "json", option: "target-scope-json" },
});

function attempts(count: number): string {
  return `${count} failed ${count === 1 ? "attempt" : "attempts"}`;
}

/** One line per matched route; `--format json` has the full outcome. */
function formatRouteDispatch(route: AutomationEventRouteDispatch): string {
  const name = `${route.routeId} (${route.routeName})`;
  switch (route.status) {
    case "pending":
      return `${name}: pending, not attempted yet`;
    case "retrying":
      return `${name}: retrying after ${attempts(route.failedAttempts)}, last error: ${route.error}`;
    case "failed":
      return `${name}: failed for good after ${attempts(route.failedAttempts)}: ${route.error}`;
    case "completed":
      return `${name}: completed, ${route.outcome.kind}${route.failedAttempts > 0 ? ` after ${attempts(route.failedAttempts)}` : ""}`;
  }
  throw new Error("Unsupported automation route dispatch status.");
}

/** What an event's routes add up to, for one row of `events.list`. */
function summarizeEventRouting({ routing }: AutomationEventDetail): string {
  if (routing.status === "matching") {
    return "matching";
  }
  if (routing.routes.length === 0) {
    return "no route";
  }
  const counts = new Map<string, number>();
  for (const route of routing.routes) {
    counts.set(route.status, (counts.get(route.status) ?? 0) + 1);
  }
  // What needs attention comes first.
  return ["failed", "retrying", "pending", "completed"]
    .flatMap((status) => {
      const count = counts.get(status);
      return count === undefined ? [] : [`${count} ${status}`];
    })
    .join(", ");
}

function formatEventRouting({ routing }: AutomationEventDetail): string[] {
  if (routing.status === "matching") {
    return ["routes", "not matched yet; run events.get again shortly"];
  }
  return [
    "routes",
    ...(routing.routes.length === 0
      ? ["no route matched"]
      : routing.routes.map(formatRouteDispatch)),
  ];
}

const fireEventTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.fire"),
  namespace: "events",
  name: "fire",
  execute: async (input, context: EventToolContext) =>
    await getEventRuntime(context.runtimes.event).emitEvent(input),
  adapters: {
    bash: {
      command: "events.fire",
      help: {
        summary: "events.fire triggers another Fragno automation event.",
        options: [
          {
            name: "event-type",
            required: true,
            valueRequired: true,
            valueName: "event-type",
            description: "Event type to emit",
          },
          {
            name: "source",
            valueRequired: true,
            valueName: "source",
            description: "Event source override. Defaults to current source",
          },
          {
            name: "subject-user-id",
            valueRequired: true,
            valueName: "subject-user-id",
            description: "Subject user id for emitted event",
          },
          {
            name: "payload-json",
            valueRequired: true,
            valueName: "json",
            description: "Event payload as JSON object",
          },
          {
            name: "target-scope-json",
            valueRequired: true,
            valueName: "json",
            description: 'Target scope as JSON, e.g. {"kind":"org","orgId":"org-1"}',
          },
        ],
        examples: [
          "events.fire --event-type identity.binding.completed --source otp --format json",
          'events.fire --event-type identity.bound --payload-json \'{"plan":"basic"}\'',
        ],
      },
      parse: parseEventFireArgs,
      format: (result) => ({ data: result }),
    },
  },
});

function readEventOutputOptions(args: string[]) {
  return readOutputOptions(parseCliTokens(args));
}

const listEventsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.list"),
  namespace: "events",
  name: "list",
  execute: async (input, context: EventToolContext) =>
    await getEventRuntime(context.runtimes.event).listEvents(input),
  adapters: {
    bash: {
      command: "events.list",
      help: {
        summary:
          "events.list lists stored automation events in the current scope, newest first, with where the routes each matched stand.",
        options: [
          {
            name: "limit",
            valueRequired: true,
            valueName: "number",
            description: "Page size (1–500; defaults to 100).",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor returned by the previous page.",
          },
        ],
        examples: [
          "events.list",
          "events.list --limit 10 --format json",
          "events.list --cursor '<cursor>'",
        ],
      },
      parse: defineCliArgsParser<EventListInput>("events.list", {
        limit: { kind: "integer" },
        cursor: {},
      }),
      outputOptions: readEventOutputOptions,
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        const lines = result.events.length
          ? [
              "id\toccurred at\tsource\tevent type\troutes",
              ...result.events.map(
                (event) =>
                  `${event.id}\t${event.occurredAt}\t${event.source}\t${event.eventType}\t${summarizeEventRouting(event)}`,
              ),
            ]
          : ["No automation events found."];
        if (result.hasNextPage && result.nextCursor) {
          lines.push(`next cursor: ${result.nextCursor}`);
        }
        return { stdout: `${lines.join("\n")}\n` };
      },
    },
  },
});

const listEventRoutesTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.routes.list"),
  namespace: "events",
  name: "routesList",
  execute: async (input, context: EventToolContext) =>
    await getEventRuntime(context.runtimes.event).listEventRoutes(input),
  adapters: {
    bash: {
      command: "events.routes.list",
      help: {
        summary:
          "events.routes.list lists the routes in one state on stored events, such as those that failed for good, newest match first.",
        options: [
          {
            name: "status",
            required: true,
            valueRequired: true,
            valueName: "status",
            description: "failed, retrying, pending, or completed.",
          },
          {
            name: "limit",
            valueRequired: true,
            valueName: "number",
            description: "Page size (1–500; defaults to 100).",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor returned by the previous page.",
          },
        ],
        examples: [
          "events.routes.list --status failed",
          "events.routes.list --status retrying --format json",
        ],
      },
      parse: defineCliArgsParser<AutomationEventRoutesListInput>("events.routes.list", {
        status: { required: true },
        limit: { kind: "integer" },
        cursor: {},
      }),
      outputOptions: readEventOutputOptions,
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        const lines = result.routes.length
          ? [
              "event id\tmatched at\troute",
              ...result.routes.map(
                ({ eventId, route }) =>
                  `${eventId}\t${route.matchedAt}\t${formatRouteDispatch(route)}`,
              ),
            ]
          : ["No routes found."];
        if (result.hasNextPage && result.nextCursor) {
          lines.push(`next cursor: ${result.nextCursor}`);
        }
        return { stdout: `${lines.join("\n")}\n` };
      },
    },
  },
});

const getEventTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.get"),
  namespace: "events",
  name: "get",
  execute: async (input, context: EventToolContext) =>
    await getEventRuntime(context.runtimes.event).getEvent(input),
  adapters: {
    bash: {
      command: "events.get",
      help: {
        summary:
          "events.get shows a stored automation event, including its payload, actors, and where each route it matched stands.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Stored event id.",
          },
        ],
        examples: ["events.get --id event-1", "events.get --id event-1 --format json"],
      },
      parse: defineCliArgsParser<{ id: string }>("events.get", { id: { required: true } }),
      outputOptions: readEventOutputOptions,
      format: (event, options) => {
        if (!event) {
          return { stderr: "Automation event not found.\n", exitCode: 1 };
        }
        if (options.format === "json" || options.print) {
          return { data: event };
        }
        return {
          stdout:
            [
              `id: ${event.id}`,
              `source: ${event.source}`,
              `event type: ${event.eventType}`,
              `occurred at: ${event.occurredAt}`,
              ...(event.createdAt ? [`created at: ${event.createdAt}`] : []),
              `scope: ${JSON.stringify(event.scope)}`,
              "",
              "payload",
              JSON.stringify(event.payload, null, 2),
              "",
              "actors",
              JSON.stringify(event.actors, null, 2),
              "",
              "subject",
              JSON.stringify(event.subject, null, 2),
              "",
              ...formatEventRouting(event),
            ].join("\n") + "\n",
        };
      },
    },
  },
});

const retryEventRouteTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.routes.retry"),
  namespace: "events",
  name: "routesRetry",
  execute: async (input, context: EventToolContext) =>
    await getEventRuntime(context.runtimes.event).retryEventRoute(input),
  adapters: {
    bash: {
      command: "events.routes.retry",
      help: {
        summary:
          "events.routes.retry runs a route that failed for good on a stored event again, as the route was when the event matched it, with the route's current permissions.",
        options: [
          {
            name: "event",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Id of the stored event, as events.routes.list or events.list shows it.",
          },
          {
            name: "route",
            required: true,
            valueRequired: true,
            valueName: "id",
            description:
              "Id of a route the event matched, as events.routes.list or events.get shows it.",
          },
        ],
        examples: ["events.routes.retry --event event-1 --route deliver-to-run"],
      },
      parse: defineCliArgsParser<{ eventId: string; routeId: string }>("events.routes.retry", {
        eventId: { required: true, option: "event" },
        routeId: { required: true, option: "route" },
      }),
      format: (route, options) => {
        if (!route) {
          return { stderr: "The event did not match this route.\n", exitCode: 1 };
        }
        return options.format === "json"
          ? { data: route }
          : { stdout: `${formatRouteDispatch(route)}\n` };
      },
    },
  },
});

/** Event runtime tools expose emission, current-scope stored event reads, and route retries. */
export const eventRuntimeTools = [
  fireEventTool,
  listEventsTool,
  getEventTool,
  listEventRoutesTool,
  retryEventRouteTool,
] as const;

export const eventFireToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: [fireEventTool],
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});

/** Retrying a route runs its action, which needs the router.modify permission. */
export const eventRetryToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: [retryEventRouteTool],
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});

/** Stored event reads use the events.read permission in the current scope. */
export const eventReadToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: [listEventsTool, getEventTool, listEventRoutesTool],
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});
