import { createAutomationCommands } from "../automation/commands/bash-adapter";
import { EVENT_COMMAND_SPEC_LIST } from "../automation/commands/registry";
import type {
  AutomationCommandContext,
  EventCommandHandlers,
  EventEmitArgs,
} from "../automation/commands/types";
import type { AutomationEvent } from "../automation/contracts";
import type { BashCommandFactoryInput } from "./bash-host";

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  orgId?: string;
  source: string;
  eventType: string;
};

export type EventBashRuntime = {
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
};

export type RegisteredEventBashCommandContext = AutomationCommandContext & {
  runtime: EventBashRuntime;
};

export type CreateEventBashRuntimeOptions = {
  env?: CloudflareEnv;
  event: AutomationEvent;
};

const eventCommandHandlers: EventCommandHandlers<RegisteredEventBashCommandContext> = {
  "event.emit": async (command, context) => {
    return {
      data: await context.runtime.emitEvent(command.args),
    };
  },
};

export const createEventBashCommands = (input: BashCommandFactoryInput) => {
  const automationContext = input.context.automation;
  if (!automationContext) {
    return [];
  }

  return createAutomationCommands(
    EVENT_COMMAND_SPEC_LIST,
    eventCommandHandlers,
    automationContext,
    input.commandCallsResult,
  );
};

const buildIngestResult = (event: AutomationEvent): AutomationEmitEventResult => ({
  accepted: true,
  eventId: event.id,
  orgId: event.orgId?.trim() || undefined,
  source: event.source,
  eventType: event.eventType,
});

export const createEventBashRuntime = ({
  env,
  event,
}: CreateEventBashRuntimeOptions): EventBashRuntime => ({
  emitEvent: async ({ eventType, source, externalActorId, actorType, subjectUserId, payload }) => {
    if (!env) {
      throw new Error("event.emit is not configured");
    }

    const orgId = event.orgId?.trim();
    if (!orgId) {
      throw new Error("event.emit requires an organisation id");
    }

    const nextEvent: AutomationEvent = {
      id: `${event.id}:${eventType}:${crypto.randomUUID()}`,
      orgId,
      source: source ?? event.source,
      eventType,
      occurredAt: new Date().toISOString(),
      payload:
        payload !== null && Array.isArray(payload) === false && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {},
      actor: externalActorId
        ? {
            type: actorType ?? event.actor?.type ?? "external",
            externalId: externalActorId,
          }
        : null,
      subject: subjectUserId ? { userId: subjectUserId } : null,
    };

    const automationsDo = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId));
    await automationsDo.triggerIngestEvent(nextEvent);

    return buildIngestResult(nextEvent);
  },
});
