import { z } from "zod";

import type { EventEmitArgs } from "@/fragno/runtime-tools/automation-types";
import {
  assertNoPositionals,
  parseCliTokens,
  readJsonOption,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  orgId?: string;
  source: string;
  eventType: string;
};

export type EventRuntime = {
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
};

type EventToolContext = BackofficeToolContext<{ event?: EventRuntime }>;

const nonEmptyString = z.string().trim().min(1);

const eventEmitInputSchema = z.object({
  eventType: nonEmptyString,
  source: nonEmptyString.optional(),
  externalActorId: nonEmptyString.optional(),
  actorType: nonEmptyString.optional(),
  subjectUserId: nonEmptyString.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const eventEmitOutputSchema = z.object({
  accepted: z.boolean(),
  eventId: nonEmptyString,
  orgId: nonEmptyString.optional(),
  source: nonEmptyString,
  eventType: nonEmptyString,
});

const defineEventRuntimeTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, EventToolContext>,
) => defineBackofficeRuntimeTool(tool);

const getEventRuntime = (runtime: EventToolContext["runtimes"]["event"]): EventRuntime => {
  if (!runtime) {
    throw new Error("Event runtime is not available in this execution context");
  }
  return runtime;
};

const parseEventEmitArgs = (args: string[]): EventEmitArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "event.emit");

  return {
    eventType: readStringOption(parsed, "event-type", true)!,
    source: readStringOption(parsed, "source"),
    externalActorId: readStringOption(parsed, "external-actor-id"),
    actorType: readStringOption(parsed, "actor-type"),
    subjectUserId: readStringOption(parsed, "subject-user-id"),
    payload: readJsonOption(parsed, "payload-json"),
  };
};

const emitEventTool = defineEventRuntimeTool({
  id: "event.emit",
  namespace: "event",
  name: "emit",
  description: "Emit another automation event for the current organisation.",
  inputSchema: eventEmitInputSchema,
  outputSchema: eventEmitOutputSchema,
  execute: async (input, context) => await getEventRuntime(context.runtimes.event).emitEvent(input),
  adapters: {
    bash: {
      command: "event.emit",
      help: {
        summary: "event.emit triggers another Fragno automation event.",
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
            name: "external-actor-id",
            valueRequired: true,
            valueName: "external-actor-id",
            description: "Actor external id override",
          },
          {
            name: "actor-type",
            valueRequired: true,
            valueName: "actor-type",
            description: "Actor type for emitted event",
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
        ],
        examples: [
          "event.emit --event-type identity.binding.completed --source otp --format json",
          'event.emit --event-type identity.bound --payload-json \'{"plan":"basic"}\'',
        ],
      },
      parse: parseEventEmitArgs,
      format: (result) => ({ data: result }),
    },
  },
});

export const eventRuntimeTools = [emitEventTool] as const;

export const eventToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "event",
  tools: eventRuntimeTools,
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});
