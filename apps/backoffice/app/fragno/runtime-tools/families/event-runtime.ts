import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { AutomationEvent } from "../../automation/contracts";
import type { EventRuntime } from "./event";

export type { EventRuntime };

export type CreateEventRuntimeOptions = {
  objects: BackofficeObjectRegistry;
  event: AutomationEvent;
  kernel?: BackofficeKernel;
  execution?: BackofficeExecutionContext;
};

const sameScope = (left: BackofficeContextScope, right: BackofficeContextScope): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "system":
      return right.kind === "system";
    case "org":
      return right.kind === "org" && left.orgId === right.orgId;
    case "user":
      return right.kind === "user" && left.userId === right.userId;
    case "project":
      return right.kind === "project" && left.projectId === right.projectId;
  }
};

export const createEventRuntime = (options: CreateEventRuntimeOptions): EventRuntime => ({
  emitEvent: async ({
    eventType,
    source,
    externalActorId,
    actorType,
    subjectUserId,
    payload,
    targetScope,
  }) => {
    const { event } = options;
    const currentScope = event.scope;
    const resolvedTargetScope = targetScope ?? currentScope;

    if (!sameScope(resolvedTargetScope, currentScope)) {
      if (!options.kernel || !options.execution) {
        throw new Error("event.emit cross-scope routing requires a Backoffice kernel");
      }
      options.kernel.assertAllowed({
        actor: options.execution.actor,
        scope: resolvedTargetScope,
        requiredPermissions: [{ namespace: "event", permission: "route" }],
        resource: { sourceScope: currentScope, targetScope: resolvedTargetScope },
      });
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
      scope: resolvedTargetScope,
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

    const targetObject = options.kernel
      ? options.kernel.scoped("AUTOMATIONS", resolvedTargetScope, options.objects.automations)
      : options.objects.automations.for(resolvedTargetScope);
    await targetObject.triggerIngestEvent(nextEvent);

    return {
      accepted: true,
      eventId: nextEvent.id,
      scope: nextEvent.scope,
      source: nextEvent.source,
      eventType: nextEvent.eventType,
    };
  },
});

export const createUnavailableEventRuntime = (
  message = "event.emit is not configured",
): EventRuntime => ({
  emitEvent: async () => {
    throw new Error(message);
  },
});
