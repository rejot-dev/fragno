import { useId, useMemo, useState } from "react";

import { itemKey, type OrchestrationGraph } from "./orchestration-graph-model";
import { ActionMarkerDefs } from "./orchestration-graph-parts";
import {
  layoutWorkflowTriggerGraph,
  relatedWorkflowTriggerItems,
  UNORIENTED,
  type WorkflowTriggerItem,
} from "./workflow-trigger-graph-model";
import { PLANET_EXTENT, WorkflowTriggerPlanet } from "./workflow-trigger-planet";

// A single scope has nowhere to forward to.
const NO_FORWARDS: ReadonlyMap<string, number> = new Map();

/**
 * What starts the scope's workflows: sources, the events of theirs that start a workflow, and the
 * workflows they start, drawn as rings from the centre out. Hovering an item lights up what it
 * starts and what starts it; clicking pins that.
 */
export function WorkflowTriggerGraph({ graph }: { graph: OrchestrationGraph }) {
  const markerIdPrefix = useId();
  const [hovered, setHovered] = useState<WorkflowTriggerItem | null>(null);
  const [pinned, setPinned] = useState<WorkflowTriggerItem | null>(null);
  const layout = useMemo(() => layoutWorkflowTriggerGraph(graph, NO_FORWARDS, UNORIENTED), [graph]);

  const active = hovered ?? pinned;
  const related = useMemo(
    () => (active ? relatedWorkflowTriggerItems(layout, active) : null),
    [layout, active],
  );
  const isPinned = (item: WorkflowTriggerItem) =>
    pinned !== null && pinned.kind === item.kind && pinned.id === item.id;
  const { width, height } = PLANET_EXTENT;

  return (
    <svg
      viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`}
      className="h-auto w-full touch-manipulation select-none"
      onClick={() => {
        setPinned(null);
      }}
      // Escape unpins from the keyboard, as clicking the background does with a pointer.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setPinned(null);
        }
      }}
    >
      <ActionMarkerDefs idPrefix={markerIdPrefix} />
      <WorkflowTriggerPlanet
        scopeLabel={graph.scopeLabel}
        layout={layout}
        forwardCounts={NO_FORWARDS}
        idPrefix={markerIdPrefix}
        markerIdPrefix={markerIdPrefix}
        emphasis={(item) => (related === null || related.has(itemKey(item)) ? 1 : 0.16)}
        workflowScale={1}
        workflowLabelReach={width / 2}
        interaction={{
          kind: "items",
          active,
          isPinned,
          onHover: setHovered,
          onToggle: (item) => {
            setPinned(isPinned(item) ? null : item);
          },
        }}
      />
    </svg>
  );
}
