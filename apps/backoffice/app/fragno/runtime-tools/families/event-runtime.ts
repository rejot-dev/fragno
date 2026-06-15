import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { AutomationEvent } from "../../automation/contracts";
import type { AutomationEmitEventResult, EventRuntime } from "./event";

export type { EventRuntime };

export type CreateEventRuntimeOptions = {
  objects: BackofficeObjectRegistry;
  event: AutomationEvent;
};

const buildIngestResult = (event: AutomationEvent): AutomationEmitEventResult => ({
  accepted: true,
  eventId: event.id,
  orgId: event.orgId?.trim() || undefined,
  source: event.source,
  eventType: event.eventType,
});

export const createEventRuntime = (options: CreateEventRuntimeOptions): EventRuntime => ({
  emitEvent: async ({ eventType, source, externalActorId, actorType, subjectUserId, payload }) => {
    const { event } = options;
    const orgId = event.orgId?.trim();
    if (!orgId) {
      throw new Error("event.emit requires an organisation id");
    }

    const nextSource = source ?? event.source;
    const baseActor = event.actor;
    const baseActors = event.actors;
    const nextActor = externalActorId
      ? {
          scope: "external" as const,
          source: nextSource,
          type: actorType ?? baseActor.type ?? "actor",
          id: externalActorId,
        }
      : baseActor;
    const nextEvent: AutomationEvent = {
      id: `${event.id}:${eventType}:${crypto.randomUUID()}`,
      orgId,
      source: nextSource,
      eventType,
      occurredAt: new Date().toISOString(),
      payload:
        payload !== null && Array.isArray(payload) === false && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {},
      actor: nextActor,
      actors: externalActorId ? [...baseActors, nextActor] : baseActors,
      subject: subjectUserId ? { userId: subjectUserId } : (event.subject ?? null),
    };

    await options.objects.automations.forOrg(orgId).triggerIngestEvent(nextEvent);

    return buildIngestResult(nextEvent);
  },
});

export const createUnavailableEventRuntime = (
  message = "event.emit is not configured",
): EventRuntime => ({
  emitEvent: async () => {
    throw new Error(message);
  },
});
