import { DENSE_GRAPH, ORGANIZATION_GRAPH } from "./orchestration-graph-story-support";
import { WorkflowTriggerGraph } from "./workflow-trigger-graph";

export default { title: "Orchestration/Workflow trigger graph" };

export function Organization() {
  return (
    <div className="mx-auto max-w-[1100px]">
      <WorkflowTriggerGraph graph={ORGANIZATION_GRAPH} />
    </div>
  );
}

export function Dense() {
  return (
    <div className="mx-auto max-w-[1100px]">
      <WorkflowTriggerGraph graph={DENSE_GRAPH} />
    </div>
  );
}

export function Empty() {
  return (
    <div className="mx-auto max-w-[1100px]">
      <WorkflowTriggerGraph graph={{ ...ORGANIZATION_GRAPH, routes: [] }} />
    </div>
  );
}
