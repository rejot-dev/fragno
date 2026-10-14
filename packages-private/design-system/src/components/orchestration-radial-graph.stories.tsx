import { useState } from "react";

import { Button } from "./button";
import type {
  OrchestrationGraph,
  OrchestrationGraphItem,
  OrchestrationGraphMode,
} from "./orchestration-graph-model";
import {
  DENSE_GRAPH,
  EVERY_ACTION_GRAPH,
  ORGANIZATION_GRAPH,
  usePulses,
} from "./orchestration-graph-story-support";
import { OrchestrationRadialGraph } from "./orchestration-radial-graph";
import { UnderlineToggleButton } from "./underline-tabs";

export default { title: "Data/Orchestration radial graph" };

function Frame({
  graph,
  initialMode,
  simulations,
}: {
  graph: OrchestrationGraph;
  initialMode: OrchestrationGraphMode;
  simulations: readonly { label: string; eventId: string; routeIds: readonly string[] }[];
}) {
  const [mode, setMode] = useState(initialMode);
  const [focusSourceId, setFocusSourceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<OrchestrationGraphItem | null>(null);
  const { pulses, fire } = usePulses();

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-stretch gap-4 shadow-[inset_0_-1px_0_var(--bo-border)]">
          <UnderlineToggleButton
            pressed={mode === "routes"}
            onClick={() => {
              setMode("routes");
            }}
          >
            Routes
          </UnderlineToggleButton>
          <UnderlineToggleButton
            pressed={mode === "catalog"}
            onClick={() => {
              setMode("catalog");
            }}
          >
            Catalog
          </UnderlineToggleButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          {focusSourceId ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFocusSourceId(null);
              }}
            >
              Clear focus
            </Button>
          ) : null}
        </div>
      </div>
      <OrchestrationRadialGraph
        graph={graph}
        mode={mode}
        focusSourceId={focusSourceId}
        onFocusSource={setFocusSourceId}
        selected={selected}
        onSelect={setSelected}
        pulses={pulses}
      />
      <p className="text-xs text-[var(--bo-muted-2)]">
        Hover to trace a path · click to pin it · double-click a source to focus it · selected:{" "}
        <span className="font-mono">{selected ? `${selected.kind}:${selected.id}` : "none"}</span>
      </p>
    </div>
  );
}

export const Organization = () => (
  <Frame
    graph={ORGANIZATION_GRAPH}
    initialMode="routes"
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
      { label: "Unrouted message", eventId: "telegram:message.received", routeIds: [] },
    ]}
  />
);

export const OrganizationCatalog = () => (
  <Frame graph={ORGANIZATION_GRAPH} initialMode="catalog" simulations={[]} />
);

export const EveryActionKind = () => (
  <Frame
    graph={EVERY_ACTION_GRAPH}
    initialMode="routes"
    simulations={[
      {
        label: "GitHub PR webhook",
        eventId: "github:webhook.received",
        routeIds: ["github-pr-classifier"],
      },
      {
        label: "PR opened",
        eventId: "github:pull_request.opened",
        routeIds: ["pr-review"],
      },
      {
        label: "Intake form",
        eventId: "forms:response.submitted",
        routeIds: ["intake-forward"],
      },
    ]}
  />
);

export const Dense = () => <Frame graph={DENSE_GRAPH} initialMode="routes" simulations={[]} />;
