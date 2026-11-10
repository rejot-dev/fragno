import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { isAutomationEventDefinitionFailure } from "@/fragno/automation/event-definitions";

import type { SiteDataProps } from "./site-data";
import type { SiteEventLimiter } from "./site-event-limiter";
import {
  checkedSiteEvent,
  SITE_EVENTS_LIMITED,
  siteEventSource,
  type SiteEvent,
  type SiteFireResult,
} from "./site-events";

/**
 * Whether whoever builds a site may emit the events its Worker fires, which its build records. Only a
 * denial builds a site that does not fire: when authority cannot be resolved, this throws, so the
 * build fails and the served build keeps firing.
 */
export async function mayFireSiteEvents({
  kernel,
  execution,
  sitePath,
}: {
  kernel: Pick<BackofficeKernel, "assertAuthorizedAll">;
  execution: BackofficeExecutionContext;
  sitePath: string;
}): Promise<boolean> {
  try {
    await kernel.assertAuthorizedAll({
      execution,
      requirements: [
        { operation: BACKOFFICE_PERMISSION.events.emit, resource: { path: sitePath } },
      ],
    });
    return true;
  } catch (error) {
    if (error instanceof BackofficeForbiddenError && error.reason !== "authority-unavailable") {
      return false;
    }
    throw error;
  }
}

/**
 * Fires an event from a site's Worker into its scope's automations, from the source
 * `site:<sitePath>`. The site initiates it and no one is its principal, so only routes that act on
 * their own authority act on it; the viewer is its subject. A build fires only if whoever built it
 * may emit events. A Worker loaded for a request an agent sends keeps its events for the agent, and
 * fires them only when the agent asked to.
 */
export async function fireSiteEvent({
  objects,
  limiter,
  props: { scope, sitePath, fires, probe },
  event,
}: {
  objects: Pick<BackofficeObjectRegistry, "automations" | "siteRequests">;
  limiter: SiteEventLimiter;
  props: SiteDataProps;
  event: SiteEvent;
}): Promise<SiteFireResult> {
  const checked = checkedSiteEvent(event);
  if ("problem" in checked) {
    return { status: "error", message: checked.problem };
  }
  if (!fires) {
    return {
      status: "error",
      message: `This build of ${sitePath} may not fire events: build it again as someone allowed events.emit.`,
    };
  }
  const keep = async (eventId: string | null) =>
    probe === undefined
      ? true
      : await objects.siteRequests
          .for(scope)
          .commands.keepProbeEvent(scope, probe.id, { ...checked.event, eventId });
  if (probe?.fire === false) {
    return (await keep(null))
      ? { status: "recorded" }
      : { status: "error", message: SITE_EVENTS_LIMITED };
  }
  const { type, payload, viewer } = checked.event;
  const key = `${backofficeContextScopeRoutePath(scope)}${sitePath}\n${viewer ?? ""}`;
  if (!(await limiter.limit(key))) {
    return { status: "error", message: SITE_EVENTS_LIMITED };
  }
  const automationEvent: AutomationEvent = {
    id: crypto.randomUUID(),
    scope,
    scopeRestriction: null,
    source: siteEventSource(sitePath),
    eventType: type,
    occurredAt: new Date().toISOString(),
    payload,
    actors: {
      initiator: { scope: "internal", type: "site", id: sitePath, role: "initiator" },
      principal: null,
      delegation: [],
    },
    // A project's events name their project, as events fired there do.
    subject:
      scope.kind === "project"
        ? { scope, ...(viewer === null ? {} : { userId: viewer }) }
        : viewer === null
          ? null
          : { userId: viewer },
    causation: { kind: "origin" },
  };
  try {
    await objects.automations.for(scope).commands.triggerIngestEvent(automationEvent);
  } catch (error) {
    if (isAutomationEventDefinitionFailure(error)) {
      return { status: "error", message: error.message };
    }
    throw error;
  }
  // Fired, so it is reported to the agent who asked even past what a request keeps.
  await keep(automationEvent.id);
  return { status: "fired", eventId: automationEvent.id };
}
