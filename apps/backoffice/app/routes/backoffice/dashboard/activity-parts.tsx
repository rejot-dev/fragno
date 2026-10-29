import type { IconName } from "@fragno-private/design-system/icon";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { formatWorkflowDuration } from "@fragno-private/design-system/workflow-run-timeline-model";

import { AUTOMATION_SCHEDULE_SOURCE } from "@/fragno/automation/route-triggers";
import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import type { EventTraceEffect, EventTraceSummary } from "./event-traces";

/** Labels registered capabilities give their event types, which a scope's own catalog overrides. */
const CAPABILITY_EVENT_LABELS = new Map(
  backofficeCapabilities.flatMap((capability) =>
    capability.contributions.automationEvents.map((event): [string, string] => [
      `${event.source}\u0000${event.eventType}`,
      event.label,
    ]),
  ),
);

/** Whether a scheduled route, rather than an event from outside, set the trace in motion. */
export function isScheduledTrace(summary: EventTraceSummary): boolean {
  return summary.source === AUTOMATION_SCHEDULE_SOURCE;
}

/** What set a trace in motion, in words: a schedule by its name, else the event and its subject. */
export function describeTraceTrigger(summary: EventTraceSummary): string {
  if (isScheduledTrace(summary)) {
    return summary.headline === null ? "On schedule" : `On schedule · ${summary.headline}`;
  }
  const label =
    summary.label ??
    CAPABILITY_EVENT_LABELS.get(`${summary.source}\u0000${summary.eventType}`) ??
    `${summary.source} · ${summary.eventType}`;
  return summary.headline === null ? label : `${label} · ${summary.headline}`;
}

/** What a trace did, named by its workflows and agents. */
export function describeTraceEffects(effects: readonly EventTraceEffect[]): string {
  // Routes are recorded before they act, so a trace without effects is still being routed.
  return effects.length === 0 ? "Routing…" : effects.map((effect) => effect.label).join(", ");
}

const EFFECT_ICON: Record<EventTraceEffect["kind"], IconName> = {
  agent: "message-square",
  workflow: "share-2",
  route: "corner-down-right",
};

/** An agent stands out among what a trace reached, since agents act on their own. */
export function traceEffectsIcon(effects: readonly EventTraceEffect[]): IconName {
  const kinds = effects.map((effect) => effect.kind);
  return EFFECT_ICON[kinds.includes("agent") ? "agent" : (kinds[0] ?? "route")];
}

/** Only what needs attention gets a status; settled work is the quiet default. */
function AttentionLight({
  failedCount,
  state,
}: {
  failedCount: number;
  state: "running" | "waiting" | null;
}) {
  if (failedCount > 0) {
    return <BackofficeStatusLight tone="failed">{failedCount} failed</BackofficeStatusLight>;
  }
  if (state === null) {
    return null;
  }
  return (
    <BackofficeStatusLight tone={state === "running" ? "live" : "waiting"}>
      {state === "running" ? "Running" : "Waiting"}
    </BackofficeStatusLight>
  );
}

export function TraceOutcome({ summary }: { summary: EventTraceSummary }) {
  const { outcome } = summary;
  if (outcome.kind === "unhandled") {
    return null;
  }
  if (outcome.kind === "in_progress" || outcome.failedCount > 0) {
    return (
      <AttentionLight
        failedCount={outcome.failedCount}
        state={outcome.kind === "in_progress" ? outcome.state : null}
      />
    );
  }
  const duration = outcome.settledAt.getTime() - summary.occurredAt.getTime();
  return duration <= 0 ? null : (
    <span
      className="shrink-0 text-xs text-[var(--bo-muted-2)] tabular-nums"
      title="From the event to the last thing it set in motion"
    >
      {formatWorkflowDuration(duration, "fine")}
    </span>
  );
}

export function RepeatsOutcome({ traces }: { traces: readonly EventTraceSummary[] }) {
  const outcomes = traces.map((trace) => trace.outcome);
  const states = outcomes.flatMap((outcome) =>
    outcome.kind === "in_progress" ? [outcome.state] : [],
  );
  return (
    <AttentionLight
      failedCount={outcomes.reduce(
        (count, outcome) => count + (outcome.kind === "unhandled" ? 0 : outcome.failedCount),
        0,
      )}
      state={states.includes("running") ? "running" : states.includes("waiting") ? "waiting" : null}
    />
  );
}
