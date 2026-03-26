import { createAutomationCommands } from "../automation/commands/bash-adapter";
import { EVENT_COMMAND_SPEC_LIST } from "../automation/commands/registry";
import type {
  AutomationCommandContext,
  EventCommandHandlers,
  EventEmitArgs,
  EventReplyArgs,
} from "../automation/commands/types";
import {
  getSourceAdapter,
  type AnyAutomationSourceAdapter,
  type AutomationEvent,
  type AutomationSourceAdapterRegistry,
} from "../automation/contracts";
import type { BashCommandFactoryInput } from "./bash-host";

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  orgId?: string;
  source: string;
  eventType: string;
};

export type AutomationReplyResult = {
  ok: true;
};

export type EventBashRuntime = {
  reply: (input: EventReplyArgs) => Promise<AutomationReplyResult>;
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
};

export type EventBashRuntimeInput = Omit<EventBashRuntime, "reply"> &
  Partial<Pick<EventBashRuntime, "reply">>;

export type RegisteredEventBashCommandContext = AutomationCommandContext & {
  runtime: EventBashRuntime;
};

export type CreateEventBashRuntimeOptions = {
  env?: CloudflareEnv;
  event: AutomationEvent;
  sourceAdapters: Partial<AutomationSourceAdapterRegistry>;
  sourceAdapter: AnyAutomationSourceAdapter | undefined;
};

const eventCommandHandlers: EventCommandHandlers<RegisteredEventBashCommandContext> = {
  "event.reply": async (command, context) => {
    return {
      data: await context.runtime.reply(command.args),
    };
  },
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
  sourceAdapters,
  sourceAdapter,
}: CreateEventBashRuntimeOptions): EventBashRuntime => ({
  reply: async ({ source, externalActorId, text }) => {
    const replySource = source ?? event.source;
    const activeSourceAdapter =
      replySource === event.source
        ? (sourceAdapter ?? getSourceAdapter(sourceAdapters, replySource))
        : getSourceAdapter(sourceAdapters, replySource);
    const replyActorId =
      externalActorId ?? (replySource === event.source ? event.actor?.externalId : undefined);

    if (typeof text !== "string" || text.length === 0) {
      throw new Error("event.reply requires a non-empty --text value");
    }

    if (!activeSourceAdapter?.reply) {
      throw new Error(`No reply handler is registered for source: ${replySource}`);
    }

    if (!replyActorId) {
      if (replySource !== event.source) {
        throw new Error(
          `event.reply requires --external-actor-id when replying through source '${replySource}' because the current event source is '${event.source}'`,
        );
      }

      throw new Error("Cannot call event.reply because no external actor id is available");
    }

    await activeSourceAdapter.reply({
      event,
      externalActorId: replyActorId,
      text,
    });

    return {
      ok: true,
    };
  },
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
