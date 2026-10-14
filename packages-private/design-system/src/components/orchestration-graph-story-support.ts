import { useEffect, useRef, useState } from "react";

import type { IconName } from "./icon";
import type {
  OrchestrationEvent,
  OrchestrationGraph,
  OrchestrationRoute,
  OrchestrationSource,
  OrchestrationTarget,
} from "./orchestration-graph-model";
import type { OrchestrationPulse } from "./orchestration-graph-parts";

// Fixtures and helpers shared by the orchestration graph stories, so every view renders the same
// automation setup.

const PULSE_LIFETIME_MS = 2_000;

function source(id: string, label: string, icon: IconName): OrchestrationSource {
  return { id, label, icon };
}

function event(
  sourceId: string,
  eventType: string,
  label: string,
  recentCount = 0,
): OrchestrationEvent {
  return { id: `${sourceId}:${eventType}`, sourceId, eventType, label, recentCount };
}

function route(
  id: string,
  eventId: string,
  label: string,
  priority: number,
  action: OrchestrationRoute["action"],
  fields: Partial<Pick<OrchestrationRoute, "enabled" | "matcher">> = {},
): OrchestrationRoute {
  return { id, eventId, label, priority, action, enabled: true, matcher: null, ...fields };
}

function workflow(id: string, activeCount = 0): OrchestrationTarget {
  return { id, label: id, kind: "workflow", activeCount };
}

// Mirrors Wilco's Organization in the local Backoffice: every built-in source, four routes.
const CATALOG_SOURCES = [
  source("telegram", "Telegram", "send"),
  source("otp", "Identity claims", "key"),
  source("automations", "Projects", "zap"),
  source("api", "Api", "code"),
  source("codemode", "Codemode", "shield"),
  source("forms", "Forms", "file-text"),
  source("github", "GitHub", "git-branch"),
  source("integrations", "Integrations", "link"),
  source("mcp", "Mcp", "cpu"),
  source("organizations", "Organizations", "users"),
  source("sandbox", "Sandbox", "cloud"),
  source("scheduler", "Scheduler", "calendar"),
  source("upload", "Upload", "upload"),
];

const CATALOG_EVENTS = [
  event("telegram", "message.received", "Telegram message received", 2),
  event("otp", "identity.claim.completed", "OTP identity claim completed", 1),
  event("automations", "project.archived", "Project archived"),
  event("automations", "project.created", "Project created", 1),
  event("automations", "project.updated", "Project updated"),
  event("api", "webhook.received", "API webhook received"),
  event("codemode", "run.completed", "Codemode run completed", 7),
  event("codemode", "run.failed", "Codemode run failed", 1),
  event("codemode", "run.started", "Codemode run started", 8),
  event("forms", "form.created", "Form created"),
  event("forms", "form.deleted", "Form deleted"),
  event("forms", "form.updated", "Form updated"),
  event("forms", "response.submitted", "Form response submitted", 3),
  event("github", "webhook.received", "GitHub webhook received", 4),
  event("integrations", "connection.disconnected", "Integration connection disconnected"),
  event("integrations", "connection.ready", "Integration connection ready", 1),
  event("integrations", "connection.unavailable", "Integration connection unavailable"),
  event("mcp", "server.configuration.changed", "MCP server configuration changed"),
  event("organizations", "organization.created", "Organization created"),
  event("organizations", "organization.updated", "Organization updated"),
  event("sandbox", "instance.failed", "Sandbox failed"),
  event("sandbox", "instance.ready", "Sandbox ready", 2),
  event("sandbox", "instance.stopped", "Sandbox stopped", 1),
  event("scheduler", "schedule.triggered", "Schedule triggered"),
  event("upload", "capability.configured", "Upload configured"),
];

export const ORGANIZATION_GRAPH: OrchestrationGraph = {
  scopeLabel: "Wilco's Organization",
  sources: CATALOG_SOURCES,
  events: CATALOG_EVENTS,
  routes: [
    route(
      "telegram-start-linking",
      "telegram:message.received",
      "Telegram /start identity linking",
      100,
      { kind: "start_workflow", targetId: "telegram-user-linking" },
      { matcher: '$.payload.text equals "/start"' },
    ),
    route(
      "telegram-pi-linking",
      "telegram:message.received",
      "Telegram Pi session linking",
      120,
      { kind: "start_workflow", targetId: "telegram-user-pi-linking" },
      { matcher: '$.payload.text startsWith "/pi"' },
    ),
    route(
      "forward-identity-claim",
      "otp:identity.claim.completed",
      "Forward Telegram identity claim completion",
      90,
      {
        kind: "send_workflow_event",
        targetId: "telegram-user-linking",
        eventType: "identity-claim-completed",
      },
    ),
    route(
      "configure-project-files",
      "automations:project.created",
      "Configure project files",
      15,
      { kind: "start_workflow", targetId: "project-files-configure" },
      { enabled: false },
    ),
  ],
  targets: [
    workflow("telegram-user-linking", 1),
    workflow("telegram-user-pi-linking"),
    workflow("project-files-configure"),
  ],
};

// Adds the action kinds the organization does not use yet: schedules, forwarding, reclassifying.
export const EVERY_ACTION_GRAPH: OrchestrationGraph = {
  ...ORGANIZATION_GRAPH,
  scopeLabel: "Acme · Platform",
  events: [
    ...CATALOG_EVENTS,
    event("github", "pull_request.opened", "Pull request opened", 3),
    event("scheduler", "schedule:daily-digest", "Daily digest · 08:00 Europe/Amsterdam"),
  ],
  routes: [
    ...ORGANIZATION_GRAPH.routes,
    route(
      "github-pr-classifier",
      "github:webhook.received",
      "Classify pull request webhooks",
      50,
      { kind: "reclassify_event", eventId: "github:pull_request.opened" },
      { matcher: '$.headers.x-github-event equals "pull_request"' },
    ),
    route("pr-review", "github:pull_request.opened", "Review new pull requests", 100, {
      kind: "start_workflow",
      targetId: "pull-request-review",
    }),
    route("daily-digest", "scheduler:schedule:daily-digest", "Daily digest", 100, {
      kind: "start_workflow",
      targetId: "daily-digest",
    }),
    route(
      "intake-forward",
      "forms:response.submitted",
      "Forward intake responses to project",
      100,
      { kind: "forward_event", targetId: "project-scope" },
      { matcher: '$.payload.formId equals "intake"' },
    ),
    route("sandbox-failure", "sandbox:instance.failed", "Notify on sandbox failure", 10, {
      kind: "start_workflow",
      targetId: "incident-notify",
    }),
    route("codemode-failure", "codemode:run.failed", "Notify on failed run", 10, {
      kind: "start_workflow",
      targetId: "incident-notify",
    }),
  ],
  targets: [
    ...ORGANIZATION_GRAPH.targets,
    workflow("pull-request-review", 2),
    workflow("daily-digest"),
    workflow("incident-notify"),
    { id: "project-scope", label: "Project · ${payload.projectId}", kind: "scope", activeCount: 0 },
  ],
};

// Many sources and routes, to see where labels give way and how the target ring spreads.
export const DENSE_GRAPH: OrchestrationGraph = (() => {
  const sources = CATALOG_SOURCES;
  const events = CATALOG_SOURCES.flatMap((catalogSource, sourceIndex) =>
    Array.from({ length: 2 + (sourceIndex % 4) }, (_, index) =>
      event(
        catalogSource.id,
        `${catalogSource.id}.event-${index + 1}`,
        `${catalogSource.label} event ${index + 1}`,
        (sourceIndex * 7 + index * 3) % 9,
      ),
    ),
  );
  const targets = Array.from({ length: 12 }, (_, index) =>
    workflow(`workflow-${String(index + 1).padStart(2, "0")}`, index % 3 === 0 ? index % 4 : 0),
  );
  const routes = events
    .filter((_, index) => index % 2 === 0)
    .flatMap((routedEvent, index) =>
      Array.from({ length: 1 + (index % 3 === 0 ? 1 : 0) }, (_, sibling) =>
        route(
          `route-${index}-${sibling}`,
          routedEvent.id,
          `Route ${index + 1}${sibling ? "b" : ""}`,
          100 + sibling * 10,
          index % 5 === 4
            ? {
                kind: "send_workflow_event",
                targetId: targets[(index * 5) % targets.length].id,
                eventType: "wake",
              }
            : { kind: "start_workflow", targetId: targets[(index + sibling) % targets.length].id },
          { enabled: index % 7 !== 6 },
        ),
      ),
    );
  return { scopeLabel: "Dense scope", sources, events, routes, targets };
})();

export function usePulses() {
  const [pulses, setPulses] = useState<readonly OrchestrationPulse[]>([]);
  const counter = useRef(0);
  const timeouts = useRef<number[]>([]);
  useEffect(
    () => () => {
      timeouts.current.forEach((timeout) => {
        window.clearTimeout(timeout);
      });
    },
    [],
  );

  return {
    pulses,
    fire: (eventId: string, routeIds: readonly string[]) => {
      counter.current += 1;
      const pulse = { id: `pulse-${counter.current}`, eventId, routeIds };
      setPulses((current) => [...current, pulse]);
      timeouts.current.push(
        window.setTimeout(() => {
          setPulses((current) => current.filter((candidate) => candidate !== pulse));
        }, PULSE_LIFETIME_MS),
      );
    },
  };
}
