import { useState } from "react";

import { Button } from "./button";
import type { OrchestrationGraph, OrchestrationGraphItem } from "./orchestration-graph-model";
import { routeActionLabel } from "./orchestration-graph-parts";
import {
  DENSE_GRAPH,
  EVERY_ACTION_GRAPH,
  ORGANIZATION_GRAPH,
  usePulses,
} from "./orchestration-graph-story-support";
import { OrchestrationLayeredGraph } from "./orchestration-layered-graph";

export default { title: "Data/Orchestration layered graph" };

// Stands in for the Backoffice inspector, which owns details in the real dashboard.
function SelectionSummary({
  graph,
  selected,
}: {
  graph: OrchestrationGraph;
  selected: OrchestrationGraphItem | null;
}) {
  const rows: [string, string][] = (() => {
    if (!selected) {
      return [["Scope", graph.scopeLabel]];
    }
    switch (selected.kind) {
      case "source": {
        const source = graph.sources.find((candidate) => candidate.id === selected.id);
        return [["Source", source?.label ?? selected.id]];
      }
      case "event": {
        const event = graph.events.find((candidate) => candidate.id === selected.id);
        return event
          ? [
              ["Event", `${event.sourceId}.${event.eventType}`],
              ["Label", event.label],
              ["Recent", String(event.recentCount)],
            ]
          : [];
      }
      case "route": {
        const route = graph.routes.find((candidate) => candidate.id === selected.id);
        return route
          ? [
              ["Route", route.label],
              ["Priority", `P${route.priority}${route.enabled ? "" : " · disabled"}`],
              ["Matcher", route.matcher ?? "every event"],
              ["Action", routeActionLabel(route.action)],
            ]
          : [];
      }
      case "target": {
        const target = graph.targets.find((candidate) => candidate.id === selected.id);
        return target
          ? [
              [target.kind === "workflow" ? "Workflow" : "Scope", target.label],
              ["Running", String(target.activeCount)],
            ]
          : [];
      }
    }
    return [];
  })();

  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border border-[var(--bo-border)] bg-[var(--bo-panel)] p-3 text-xs">
      {rows.map(([term, definition]) => (
        <div key={term} className="contents">
          <dt className="tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">{term}</dt>
          <dd className="truncate font-mono text-[var(--bo-fg)]">{definition}</dd>
        </div>
      ))}
    </dl>
  );
}

function Frame({
  graph,
  simulations,
  height,
}: {
  graph: OrchestrationGraph;
  simulations: readonly { label: string; eventId: string; routeIds: readonly string[] }[];
  // A number boxes the graph in, the way a dashboard panel would; "content" lets it grow.
  height: number | "content";
}) {
  const [selected, setSelected] = useState<OrchestrationGraphItem | null>(null);
  const { pulses, fire } = usePulses();

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {simulations.map((simulation) => (
          <Button
            key={simulation.label}
            variant="secondary"
            onClick={() => {
              fire(simulation.eventId, simulation.routeIds);
            }}
          >
            {simulation.label}
          </Button>
        ))}
      </div>
      <div style={{ height: height === "content" ? undefined : height }}>
        <OrchestrationLayeredGraph
          graph={graph}
          selected={selected}
          onSelect={setSelected}
          pulses={pulses}
        />
      </div>
      <SelectionSummary graph={graph} selected={selected} />
    </div>
  );
}

export const Organization = () => (
  <Frame
    graph={ORGANIZATION_GRAPH}
    height="content"
    simulations={[
      {
        label: "Telegram /start",
        eventId: "telegram:message.received",
        routeIds: ["telegram-start-linking"],
      },
      {
        label: "Identity claimed",
        eventId: "otp:identity.claim.completed",
        routeIds: ["forward-identity-claim"],
      },
    ]}
  />
);

export const EveryActionKind = () => (
  <Frame
    graph={EVERY_ACTION_GRAPH}
    height="content"
    simulations={[
      {
        label: "GitHub PR webhook",
        eventId: "github:webhook.received",
        routeIds: ["github-pr-classifier"],
      },
      { label: "PR opened", eventId: "github:pull_request.opened", routeIds: ["pr-review"] },
      { label: "Intake form", eventId: "forms:response.submitted", routeIds: ["intake-forward"] },
    ]}
  />
);

export const Dense = () => <Frame graph={DENSE_GRAPH} simulations={[]} height="content" />;

export const LimitedHeight = () => <Frame graph={DENSE_GRAPH} simulations={[]} height={420} />;
