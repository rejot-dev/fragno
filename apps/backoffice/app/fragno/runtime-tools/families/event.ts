import { z } from "zod";

import type { EventEmitArgs } from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

const contextScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }),
  z.object({ kind: z.literal("org"), orgId: z.string().trim().min(1) }),
  z.object({ kind: z.literal("user"), userId: z.string().trim().min(1) }),
  z.object({ kind: z.literal("project"), projectId: z.string().trim().min(1) }),
]);

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  scope: z.infer<typeof contextScopeSchema>;
  source: string;
  eventType: string;
};

export type EventRuntime = {
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
};

type EventToolContext = BackofficeToolContext<{ event?: EventRuntime }>;

const eventEmitInputSchema = z.object({
  eventType: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
  externalActorId: z.string().trim().min(1).optional(),
  actorType: z.string().trim().min(1).optional(),
  subjectUserId: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  targetScope: contextScopeSchema.optional(),
});

const eventEmitOutputSchema = z.object({
  accepted: z.boolean(),
  eventId: z.string().trim().min(1),
  scope: contextScopeSchema,
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
});

const getEventRuntime = (runtime: EventToolContext["runtimes"]["event"]): EventRuntime => {
  if (!runtime) {
    throw new Error("Event runtime is not available in this execution context");
  }
  return runtime;
};

const parseEventEmitArgs = defineCliArgsParser<EventEmitArgs>("event.emit", {
  eventType: { required: true },
  source: {},
  externalActorId: {},
  actorType: {},
  subjectUserId: {},
  payload: { kind: "json", option: "payload-json" },
  targetScope: { kind: "json", option: "target-scope-json" },
});

const emitEventTool = defineBackofficeRuntimeTool({
  id: "event.emit",
  namespace: "event",
  name: "emit",
  description: "Emit another automation event for the current organisation.",
  requiredPermissions: ["emit"],
  inputSchema: eventEmitInputSchema,
  outputSchema: eventEmitOutputSchema,
  execute: async (input, context: EventToolContext) =>
    await getEventRuntime(context.runtimes.event).emitEvent(input),
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
          {
            name: "target-scope-json",
            valueRequired: true,
            valueName: "json",
            description: 'Target scope as JSON, e.g. {"kind":"org","orgId":"org-1"}',
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
  permissions: {
    emit: "Emit automation events within the current scope.",
    route: "Route automation events to another selected scope.",
  },
  tools: eventRuntimeTools,
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});
