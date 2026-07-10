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
  parentEvent?: AutomationEvent;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
};

const automationActorFromPrincipal = (actor: BackofficePrincipal): AutomationEventActor => {
  if (actor.type === "system") {
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
    const { parentEvent } = options;
    const currentScope = options.execution.scope;
    if (parentEvent && !backofficeContextScopesEqual(parentEvent.scope, currentScope)) {
      throw new Error("Parent automation event scope must match the execution scope.");
    }

    const resolvedTargetScope = targetScope ?? currentScope;

    if (!backofficeContextScopesEqual(resolvedTargetScope, currentScope)) {
      options.kernel.assertAutomationForwardTargetAllowed({
        ownerScope: currentScope,
        targetScope: resolvedTargetScope,
        routeId: "events.fire",
      });
      options.kernel.assertAllowed({
        actor: options.execution.actor,
        scope: resolvedTargetScope,
        requiredPermissions: [{ namespace: "events", permission: "route" }],
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

    const nextSource = source ?? parentEvent?.source;
    if (!nextSource) {
      throw new Error("events.fire source is required without a parent automation event.");
    }

    const baseActor = parentEvent?.actor ?? automationActorFromPrincipal(options.execution.actor);
    const baseActors = parentEvent?.actors ?? [baseActor];
    const nextActor = externalActorId
      ? (() => {
          if (!actorType) {
            throw new Error("events.fire actorType is required when externalActorId is provided.");
          }
          return {
            scope: "external" as const,
            source: nextSource,
            type: actorType,
            id: externalActorId,
          };
        })()
      : baseActor;
    const nextEvent: AutomationEvent = {
      id: crypto.randomUUID(),
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
              ...parentEvent?.subject,
              orgId: resolvedTargetScope.orgId,
              projectId: targetProject!.projectId,
              ...(subjectUserId ? { userId: subjectUserId } : {}),
            }
          : subjectUserId
            ? { userId: subjectUserId }
            : (parentEvent?.subject ?? null),
    };

    const targetObject = options.kernel.scoped(
      "AUTOMATIONS",
      resolvedTargetScope,
      options.objects.automations,
    );
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
  message = "events.fire is not configured",
): EventRuntime => ({
  emitEvent: async () => {
    throw new Error(message);
  },
});
