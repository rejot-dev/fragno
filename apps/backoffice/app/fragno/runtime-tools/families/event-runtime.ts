import {
  backofficeContextScopesEqual,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { AutomationActors } from "../../automation/actors";
import type { AutomationEvent } from "../../automation/contracts";
import { automationEventListResultSchema } from "../../automation/events";
import { createAutomationsRouteCaller } from "../../automation/route-callers";
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

/** Builds an event runtime whose reads authorize against the same scope as emission. */
export function createEventRuntime(options: CreateEventRuntimeOptions): EventRuntime {
  const callRoute = createAutomationsRouteCaller({
    object: options.kernel.scoped(
      "AUTOMATIONS",
      options.execution.scope,
      options.objects.automations,
    ),
    context: { execution: options.execution },
  });
  return {
    listEvents: async ({ limit, cursor }) => {
      const query: Record<string, string> = {};
      if (limit !== undefined) {
        query.limit = limit.toString();
      }
      if (cursor !== undefined) {
        query.cursor = cursor;
      }
      const response = await callRoute("GET", "/events", { query });
      if (response.type === "json") {
        return automationEventListResultSchema.parse(response.data);
      }
      throw new Error(
        `Events backend returned ${response.status}${response.type === "error" ? `: ${response.error.message}` : ""}`,
      );
    },
    getEvent: async ({ id }) => {
      const response = await callRoute("GET", "/events/:eventId", { pathParams: { eventId: id } });
      if (response.type === "error" && response.status === 404) {
        return null;
      }
      if (response.type === "json") {
        return automationEventListResultSchema.shape.events.element.parse(response.data);
      }
      throw new Error(
        `Events backend returned ${response.status}${response.type === "error" ? `: ${response.error.message}` : ""}`,
      );
    },
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
  };
}

/** Provides the same unavailable-runtime failure for stored event reads and emission. */
export function createUnavailableEventRuntime(
  message = "Events runtime is not available in this execution context",
): EventRuntime {
  return {
    emitEvent: async () => {
      throw new Error(message);
    },
    listEvents: async () => {
      throw new Error(message);
    },
    getEvent: async () => {
      throw new Error(message);
    },
  };
}
