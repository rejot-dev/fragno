import {
  backofficeContextScopesEqual,
  type BackofficeExecutionContext,
  type BackofficePrincipal,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import {
  AUTOMATION_SYSTEM_ACTOR,
  type AutomationEvent,
  type AutomationEventActor,
} from "../../automation/contracts";
import type { EventRuntime } from "./event";

export type { EventRuntime };

export type CreateEventRuntimeOptions = {
  objects: BackofficeObjectRegistry;
  event?: AutomationEvent;
  kernel?: BackofficeKernel;
  execution?: BackofficeExecutionContext;
  defaultSource?: string;
};

const automationActorFromPrincipal = (
  actor: BackofficePrincipal | undefined,
): AutomationEventActor => {
  if (!actor || actor.type === "system") {
    return AUTOMATION_SYSTEM_ACTOR;
  }

  if (actor.type === "user") {
    return {
      scope: "internal",
      type: "user",
      id: actor.userId,
      role: "principal",
    };
  }

  return {
    scope: "internal",
    type: actor.type,
    id: actor.id,
    role: actor.type === "object" ? "delegate" : "principal",
  };
};

const normalizeEventPayload = (payload: Record<string, unknown> | undefined) =>
  payload !== null && Array.isArray(payload) === false && typeof payload === "object"
    ? payload
    : {};

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
    const currentScope = event?.scope ?? options.execution?.scope ?? { kind: "system" };
    const resolvedTargetScope = targetScope ?? currentScope;

    if (!backofficeContextScopesEqual(resolvedTargetScope, currentScope)) {
      if (!options.kernel || !options.execution) {
        throw new Error("event.emit cross-scope routing requires a Backoffice kernel");
      }
      options.kernel.assertAutomationForwardTargetAllowed({
        ownerScope: currentScope,
        targetScope: resolvedTargetScope,
        routeId: "event.emit",
      });
      options.kernel.assertAllowed({
        actor: options.execution.actor,
        scope: resolvedTargetScope,
        requiredPermissions: [{ namespace: "event", permission: "route" }],
        resource: { sourceScope: currentScope, targetScope: resolvedTargetScope },
      });
    }

    const targetProject =
      resolvedTargetScope.kind === "project"
        ? await options.objects.automations
            .forOrg(resolvedTargetScope.orgId)
            .resolveProjectForExecution({ projectId: resolvedTargetScope.projectId })
        : null;

    if (resolvedTargetScope.kind === "project" && !targetProject) {
      throw new Error(`Project '${resolvedTargetScope.projectId}' is not available.`);
    }

    const nextSource = source ?? event?.source ?? options.defaultSource ?? "backoffice";
    const baseActor = event?.actor ?? automationActorFromPrincipal(options.execution?.actor);
    const baseActors = event?.actors ?? [baseActor];
    const nextActor = externalActorId
      ? {
          scope: "external" as const,
          source: nextSource,
          type: actorType ?? baseActor.type ?? "actor",
          id: externalActorId,
        }
      : baseActor;
    const nextEvent: AutomationEvent = {
      id: event
        ? `${event.id}:${eventType}:${crypto.randomUUID()}`
        : `${nextSource}:${eventType}:${crypto.randomUUID()}`,
      scope: resolvedTargetScope,
      source: nextSource,
      eventType,
      occurredAt: new Date().toISOString(),
      payload: normalizeEventPayload(payload),
      actor: nextActor,
      actors: externalActorId ? [...baseActors, nextActor] : baseActors,
      subject:
        resolvedTargetScope.kind === "project"
          ? {
              ...event?.subject,
              orgId: resolvedTargetScope.orgId,
              projectId: targetProject!.projectId,
              ...(subjectUserId ? { userId: subjectUserId } : {}),
            }
          : subjectUserId
            ? { userId: subjectUserId }
            : (event?.subject ?? null),
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
