import {
  backofficeContextScopesEqual,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { AutomationActors } from "../../automation/actors";
import type { AutomationEvent } from "../../automation/contracts";
import type { EventRuntime } from "./event";

export type { EventRuntime };

export type CreateEventRuntimeOptions = {
  objects: BackofficeObjectRegistry;
  parentEvent?: AutomationEvent;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  emittedEventActors?: AutomationActors;
};

const normalizeEventPayload = (payload: Record<string, unknown> | undefined) =>
  payload !== null && !Array.isArray(payload) && typeof payload === "object" ? payload : {};

export const createEventRuntime = (options: CreateEventRuntimeOptions): EventRuntime => ({
  emitEvent: async ({ eventType, source, subjectUserId, payload, targetScope }) => {
    const { parentEvent } = options;
    const currentScope = options.execution.scope;
    if (parentEvent && !backofficeContextScopesEqual(parentEvent.scope, currentScope)) {
      throw new Error("Parent automation event scope must match the execution scope.");
    }

    const resolvedTargetScope = targetScope ?? currentScope;

    if (!backofficeContextScopesEqual(resolvedTargetScope, currentScope)) {
      await options.kernel.assertScopeAllowedByOwner({
        ownerScope: currentScope,
        targetScope: resolvedTargetScope,
        operation: "automation.forward-event",
      });
      options.kernel.assertScopedContextAccess(options.execution, resolvedTargetScope);
    }

    const targetProject =
      resolvedTargetScope.kind === "project"
        ? await options.objects.automations
            .forOrg(resolvedTargetScope.orgId)
            .commands.resolveProjectForExecution({ projectId: resolvedTargetScope.projectId })
        : null;

    if (resolvedTargetScope.kind === "project" && !targetProject) {
      throw new Error(`Project '${resolvedTargetScope.projectId}' is not available.`);
    }

    const nextSource = source ?? parentEvent?.source;
    if (!nextSource) {
      throw new Error("events.fire source is required without a parent automation event.");
    }

    const nextEvent: AutomationEvent = {
      id: crypto.randomUUID(),
      scope: resolvedTargetScope,
      source: nextSource,
      eventType,
      occurredAt: new Date().toISOString(),
      payload: normalizeEventPayload(payload),
      actors: options.emittedEventActors ?? options.execution.actors,
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
    await targetObject.commands.triggerIngestEvent(nextEvent);

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
