import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationEvent,
  type AutomationEventCausation,
  automationEventDetailSchema,
  automationEventListResultSchema,
  automationEventRoutesListResultSchema,
  automationEventRouteDispatchSchema,
  automationEventParentOf,
} from "@fragno-dev/backoffice-api/v0/events";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import {
  BackofficeOperationError,
  backofficeOperationErrorKindForStatus,
} from "@/backoffice-runtime/operation-error";

import { isInstalledAppEventSource } from "../../app-installations/authority";
import { rethrowAutomationEventDefinitionFailure } from "../../automation/event-definitions";
import { createAutomationsRouteCaller } from "../../automation/route-callers";
import type { EventRuntime } from "./event";

export type { EventRuntime };

/**
 * Who fires events through the runtime. Events a workflow fires inherit the source and subject of
 * the event it runs with, and record the workflow as their cause.
 */
export type EventEmitter =
  | { kind: "caller" }
  | {
      kind: "workflow";
      workflowName: string;
      instanceId: string;
      /** A manual start synthesizes this event; it was never recorded, so it cannot be a parent. */
      startedBy: "event" | "manual";
      event: AutomationEvent;
    };

export type CreateEventRuntimeOptions = {
  objects: BackofficeObjectRegistry;
  emitter: EventEmitter;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  emittedEventActors?: AutomationActors;
  /** Installed apps always emit as `app:<appId>`, so automations can trust that source. */
  emittedEventSource?: string;
};

const normalizeEventPayload = (payload: Record<string, unknown> | undefined) =>
  payload !== null && !Array.isArray(payload) && typeof payload === "object" ? payload : {};

function emittedEventCausation(emitter: EventEmitter): AutomationEventCausation {
  if (emitter.kind === "caller") {
    return { kind: "origin" };
  }
  return {
    kind: "workflow",
    workflowName: emitter.workflowName,
    instanceId: emitter.instanceId,
    parent: emitter.startedBy === "event" ? automationEventParentOf(emitter.event) : null,
  };
}

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
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Events backend returned ${response.status}${response.type === "error" ? `: ${response.error.message}` : ""}`,
      );
    },
    listEventRoutes: async ({ status, limit, cursor }) => {
      const query: Record<string, string> = { status };
      if (limit !== undefined) {
        query.limit = limit.toString();
      }
      if (cursor !== undefined) {
        query.cursor = cursor;
      }
      const response = await callRoute("GET", "/event-routes", { query });
      if (response.type === "json") {
        return automationEventRoutesListResultSchema.parse(response.data);
      }
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Events backend returned ${response.status}${response.type === "error" ? `: ${response.error.message}` : ""}`,
      );
    },
    getEvent: async ({ id }) => {
      const response = await callRoute("GET", "/events/:eventId", { pathParams: { eventId: id } });
      if (response.type === "error" && response.status === 404) {
        return null;
      }
      if (response.type === "json") {
        return automationEventDetailSchema.parse(response.data);
      }
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Events backend returned ${response.status}${response.type === "error" ? `: ${response.error.message}` : ""}`,
      );
    },
    retryEventRoute: async ({ eventId, routeId }) => {
      const response = await callRoute("POST", "/events/:eventId/routes/:routeId/retry", {
        pathParams: { eventId, routeId },
      });
      if (response.type === "error" && response.status === 404) {
        return null;
      }
      if (response.type === "json") {
        return automationEventRouteDispatchSchema.parse(response.data);
      }
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Events backend returned ${response.status}${response.type === "error" ? `: ${response.error.message}` : ""}`,
      );
    },
    emitEvent: async ({ eventType, source, subjectUserId, payload, targetScope }) => {
      const { emitter } = options;
      const parentEvent = emitter.kind === "workflow" ? emitter.event : undefined;
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
              .for(resolvedTargetScope.owner)
              .commands.resolveProjectForExecution({ projectId: resolvedTargetScope.projectId })
          : null;

      if (resolvedTargetScope.kind === "project" && !targetProject) {
        throw new BackofficeOperationError(
          "not_found",
          `Project '${resolvedTargetScope.projectId}' is not available.`,
        );
      }

      const { emittedEventSource } = options;
      if (source !== undefined && source !== emittedEventSource) {
        if (emittedEventSource !== undefined) {
          throw new BackofficeForbiddenError(
            `Events from this credential have the source '${emittedEventSource}'.`,
          );
        }
        // Inheriting a parent event's app source stays allowed: that event came from the app.
        if (isInstalledAppEventSource(source)) {
          throw new BackofficeForbiddenError(
            `The event source '${source}' belongs to an installed app.`,
          );
        }
      }
      const nextSource = emittedEventSource ?? source ?? parentEvent?.source;
      if (!nextSource) {
        throw new Error("events.fire source is required without a parent automation event.");
      }

      const nextEvent: AutomationEvent = {
        id: crypto.randomUUID(),
        scope: resolvedTargetScope,
        scopeRestriction: backofficeExecutionScopeRestriction(options.execution),
        source: nextSource,
        eventType,
        occurredAt: new Date().toISOString(),
        payload: normalizeEventPayload(payload),
        actors: options.emittedEventActors ?? options.execution.actors,
        subject:
          resolvedTargetScope.kind === "project"
            ? {
                ...parentEvent?.subject,
                scope: resolvedTargetScope,
                ...(subjectUserId ? { userId: subjectUserId } : {}),
              }
            : subjectUserId
              ? { userId: subjectUserId }
              : (parentEvent?.subject ?? null),
        causation: emittedEventCausation(emitter),
      };

      const targetObject = options.kernel.scoped(
        "AUTOMATIONS",
        resolvedTargetScope,
        options.objects.automations,
      );
      await targetObject.commands
        .triggerIngestEvent(nextEvent)
        .catch(rethrowAutomationEventDefinitionFailure);

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
    listEventRoutes: async () => {
      throw new Error(message);
    },
    getEvent: async () => {
      throw new Error(message);
    },
    retryEventRoute: async () => {
      throw new Error(message);
    },
  };
}
