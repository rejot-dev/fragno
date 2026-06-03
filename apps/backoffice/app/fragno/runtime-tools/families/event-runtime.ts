import type { AutomationEvent } from "../../automation/contracts";
import type { AutomationEmitEventResult, EventRuntime } from "./event";

export type { AutomationEmitEventResult, EventRuntime };

export type CreateEventRuntimeOptions = {
  env?: CloudflareEnv;
  event: AutomationEvent;
};

const buildIngestResult = (event: AutomationEvent): AutomationEmitEventResult => ({
  accepted: true,
  eventId: event.id,
  orgId: event.orgId?.trim() || undefined,
  source: event.source,
  eventType: event.eventType,
});

export const createEventRuntime = ({ env, event }: CreateEventRuntimeOptions): EventRuntime => ({
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
