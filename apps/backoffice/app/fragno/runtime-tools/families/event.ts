import type { EventListInput } from "@fragno-dev/backoffice-api/v0/events";
import {
  automationEventListResultSchema,
  type AutomationEventRecord,
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
  getEvent(input: { id: string }): Promise<AutomationEventRecord | null>;
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
        summary: "events.list lists stored automation events in the current scope, newest first.",
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
              "id\toccurred at\tsource\tevent type",
              ...result.events.map(
                (event) => `${event.id}\t${event.occurredAt}\t${event.source}\t${event.eventType}`,
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
        summary: "events.get shows a stored automation event, including its payload and actors.",
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
            ].join("\n") + "\n",
        };
      },
    },
  },
});

/** Event runtime tools expose emission and current-scope stored event reads. */
export const eventRuntimeTools = [fireEventTool, listEventsTool, getEventTool] as const;

export const eventFireToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: [fireEventTool],
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});

/** Stored event reads use the events.read permission in the current scope. */
export const eventReadToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: [listEventsTool, getEventTool],
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});
