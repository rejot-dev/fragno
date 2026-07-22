import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";
import type { EventEmitArgs } from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import {
  automationEventsCatalogCreateTool,
  automationEventsCatalogGetTool,
  automationEventsCatalogListTool,
} from "./backoffice-capabilities";

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
};

export type EventRuntime = {
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
};

type EventToolContext = BackofficeToolContext<{ event?: EventRuntime }>;
type EventCatalogToolContext = BackofficeToolContext<{ backoffice?: unknown }>;

const eventEmitInputSchema = z.object({
  eventType: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
  externalActorId: z.string().trim().min(1).optional(),
  actorType: z.string().trim().min(1).optional(),
  subjectUserId: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  targetScope: backofficeContextScopeSchema.optional(),
});

const eventEmitOutputSchema = z.object({
  accepted: z.boolean(),
  eventId: z.string().trim().min(1),
  scope: backofficeContextScopeSchema,
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
});

const getEventRuntime = (runtime: EventToolContext["runtimes"]["event"]): EventRuntime => {
  if (!runtime) {
    throw new Error("Events runtime is not available in this execution context");
  }
  return runtime;
};

const parseEventFireArgs = defineCliArgsParser<EventEmitArgs>("events.fire", {
  eventType: { required: true },
  source: {},
  externalActorId: {},
  actorType: {},
  subjectUserId: {},
  payload: { kind: "json", option: "payload-json" },
  targetScope: { kind: "json", option: "target-scope-json" },
});

const fireEventTool = defineBackofficeRuntimeTool({
  id: "events.fire",
  namespace: "events",
  name: "fire",
  description: "Fire an automation event for the current context or a selected target scope.",
  requiredPermissions: ["emit"],
  inputSchema: eventEmitInputSchema,
  outputSchema: eventEmitOutputSchema,
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
          "events.fire --event-type identity.binding.completed --source otp --format json",
          'events.fire --event-type identity.bound --payload-json \'{"plan":"basic"}\'',
        ],
      },
      parse: parseEventFireArgs,
      format: (result) => ({ data: result }),
    },
  },
});

export const eventRuntimeTools = [
  fireEventTool,
  automationEventsCatalogListTool,
  automationEventsCatalogGetTool,
  automationEventsCatalogCreateTool,
] as const;

export const eventFireToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  permissions: {
    emit: "Fire automation events within the current scope.",
    route: "Route automation events to another selected scope.",
  },
  tools: [fireEventTool],
  isAvailable: (context: EventToolContext) => !!context.runtimes.event,
});

export const eventCatalogToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  permissions: {
    read: "Read automation event catalog entries.",
    manage: "Manage dynamic automation event catalog entries.",
  },
  tools: [
    automationEventsCatalogListTool,
    automationEventsCatalogGetTool,
    automationEventsCatalogCreateTool,
  ],
  isAvailable: (context: EventCatalogToolContext) => !!context.runtimes.backoffice,
});
