import type {
  AutomationEventCatalogEntry,
  AutomationEventCatalogGetInput,
  AutomationEventsCatalogListOutput,
} from "@fragno-dev/backoffice-api/v0/events";
import type {
  AutomationEventDefinition,
  AutomationEventDefinitionCreateInput,
} from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";
import { formatJsonSchemaFields } from "@/lib/zod/zod-formatter";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

/** Event catalog runtime combines built-in descriptors with definitions owned by the current scope. */
export type EventCatalogRuntime = {
  listAutomationEvents(): Promise<AutomationEventsCatalogListOutput>;
  getAutomationEvent(
    input: AutomationEventCatalogGetInput,
  ): Promise<AutomationEventCatalogEntry | null>;
  createAutomationEvent(
    input: AutomationEventDefinitionCreateInput,
  ): Promise<AutomationEventDefinition>;
};

type EventCatalogToolContext = BackofficeToolContext<{ eventCatalog?: EventCatalogRuntime }>;
type OutputOptions = ReturnType<typeof readOutputOptions>;

function getEventCatalogRuntime(context: EventCatalogToolContext): EventCatalogRuntime {
  if (!context.runtimes.eventCatalog) {
    throw new Error("Event catalog runtime is not available in this execution context");
  }
  return context.runtimes.eventCatalog;
}

function readCatalogOutputOptions(args: string[]) {
  return readOutputOptions(parseCliTokens(args));
}

function readCatalogCreateOutputOptions(args: string[]) {
  const parsed = parseCliTokens(args);
  parsed.options.delete("json");
  return readOutputOptions(parsed);
}

function parseAutomationEventCatalogCreate(args: string[]) {
  const { payload } = defineCliArgsParser<{ payload: unknown }>("events.catalog.create", {
    payload: { kind: "json", option: "json", required: true },
  })(args);
  return payload as AutomationEventDefinitionCreateInput;
}

function formatAutomationEventsCatalogList(
  data: AutomationEventsCatalogListOutput,
  options: OutputOptions,
) {
  if (options.format === "json" || options.print) {
    return { data };
  }
  const headers = ["source", "event type", "capability", "label"];
  const rows = data.map((item) => [item.source, item.eventType, item.capabilityId, item.label]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const renderRow = (row: string[]) =>
    row
      .map((value, index) => value.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return {
    stdout:
      [
        renderRow(headers),
        renderRow(widths.map((width) => "-".repeat(width))),
        ...rows.map(renderRow),
      ].join("\n") + "\n",
  };
}

function formatAutomationEventCatalogEntry(
  data: AutomationEventCatalogEntry | null,
  options: OutputOptions,
) {
  if (!data) {
    return { stderr: "Automation event not found\n", exitCode: 1 };
  }
  if (options.format === "json" || options.print) {
    return { data };
  }
  return {
    stdout: `${data.source}:${data.eventType}\n${data.description ?? data.label}\n\npayload\n${formatJsonSchemaFields(data.payloadSchema)}\n\nactor\n${formatJsonSchemaFields(data.actorSchema)}\n\nsubject\n${formatJsonSchemaFields(data.subjectSchema)}\n`,
  };
}

function formatAutomationEventDefinitionEntry(
  data: AutomationEventDefinition,
  options: OutputOptions,
) {
  return formatAutomationEventCatalogEntry(
    {
      ...data,
      description: data.description ?? undefined,
      payloadSchema: data.payloadSchema ?? undefined,
      actorSchema: data.actorSchema ?? undefined,
      subjectSchema: data.subjectSchema ?? undefined,
      example: data.example ?? undefined,
    },
    options,
  );
}

/** Lists event catalog summaries without expanding their JSON schemas. */
export const automationEventsCatalogListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.catalog.list"),
  namespace: "events",
  name: "catalogList",
  execute: async (_input, context: EventCatalogToolContext) =>
    await getEventCatalogRuntime(context).listAutomationEvents(),
  adapters: {
    bash: {
      command: "events.catalog.list",
      help: {
        summary: "events.catalog.list lists known automation event source/type pairs.",
        options: [],
        examples: ["events.catalog.list", "events.catalog.list --format json"],
      },
      parse: defineNoInputArgsParser("events.catalog.list"),
      outputOptions: readCatalogOutputOptions,
      format: formatAutomationEventsCatalogList,
    },
  },
});

/** Gets an event catalog descriptor, including its payload, actor, and subject schemas. */
export const automationEventsCatalogGetTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.catalog.get"),
  namespace: "events",
  name: "catalogGet",
  execute: async (input, context: EventCatalogToolContext) =>
    await getEventCatalogRuntime(context).getAutomationEvent(input),
  adapters: {
    bash: {
      command: "events.catalog.get",
      help: {
        summary: "events.catalog.get returns one automation event descriptor and its JSON schemas.",
        options: [
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "Automation event source.",
          },
          {
            name: "event-type",
            required: true,
            valueRequired: true,
            valueName: "event-type",
            description: "Automation event type.",
          },
        ],
        examples: [
          "events.catalog.get --source telegram --event-type message.received",
          "events.catalog.get --source telegram --event-type message.received --format json",
        ],
      },
      parse: defineCliArgsParser<AutomationEventCatalogGetInput>("events.catalog.get", {
        source: { required: true },
        eventType: { required: true },
      }),
      outputOptions: readCatalogOutputOptions,
      format: formatAutomationEventCatalogEntry,
    },
  },
});

/** Creates a dynamic event catalog definition in the current scope. */
export const automationEventsCatalogCreateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("events.catalog.create"),
  namespace: "events",
  name: "catalogCreate",
  execute: async (input, context: EventCatalogToolContext) =>
    await getEventCatalogRuntime(context).createAutomationEvent(input),
  adapters: {
    bash: {
      command: "events.catalog.create",
      help: {
        summary: "events.catalog.create creates a dynamic automation event definition.",
        options: [
          {
            name: "json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Event definition JSON payload.",
          },
        ],
        examples: [
          'events.catalog.create --json \'{"source":"custom","eventType":"thing.created","label":"Thing created","payloadSchema":{"type":"object","required":["thingId"],"properties":{"thingId":{"type":"string"}}}}\' --format json',
        ],
      },
      parse: parseAutomationEventCatalogCreate,
      outputOptions: readCatalogCreateOutputOptions,
      format: formatAutomationEventDefinitionEntry,
    },
  },
});

/** Builds the event catalog from static descriptors and scoped dynamic definitions. */
export function createEventCatalogRuntime({
  objects,
  scope,
}: {
  objects: BackofficeObjectRegistry;
  scope: BackofficeContextScope;
}): EventCatalogRuntime {
  return {
    listAutomationEvents: async () => {
      const staticEvents = listAutomationEventDescriptors().map(
        ({ payloadSchema, actorSchema, subjectSchema, ...event }) => event,
      );
      const dynamicEvents = await objects.automations.for(scope).commands.listEventDefinitions();
      return [
        ...staticEvents,
        ...dynamicEvents.map(
          ({ payloadSchema, actorSchema, subjectSchema, description, example, ...event }) => ({
            ...event,
            description: description ?? undefined,
            example: example ?? undefined,
          }),
        ),
      ];
    },
    getAutomationEvent: async ({ source, eventType }) => {
      const staticEvent = listAutomationEventDescriptors().find(
        (event) => event.source === source && event.eventType === eventType,
      );
      if (staticEvent) {
        return staticEvent;
      }
      const dynamicEvent = await objects.automations
        .for(scope)
        .commands.getEventDefinition({ source, eventType });
      if (!dynamicEvent) {
        return null;
      }
      return {
        ...dynamicEvent,
        description: dynamicEvent.description ?? undefined,
        payloadSchema: dynamicEvent.payloadSchema ?? undefined,
        actorSchema: dynamicEvent.actorSchema ?? undefined,
        subjectSchema: dynamicEvent.subjectSchema ?? undefined,
        example: dynamicEvent.example ?? undefined,
      };
    },
    createAutomationEvent: async (input) =>
      await objects.automations.for(scope).commands.createEventDefinition(input),
  };
}

/** Event catalog tools share current-scope ownership with their runtime. */
export const eventCatalogRuntimeTools = [
  automationEventsCatalogListTool,
  automationEventsCatalogGetTool,
  automationEventsCatalogCreateTool,
] as const;

/** Event catalog availability is independent of event emission and stored event reads. */
export const eventCatalogToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: eventCatalogRuntimeTools,
  isAvailable: (context: EventCatalogToolContext) => !!context.runtimes.eventCatalog,
});
