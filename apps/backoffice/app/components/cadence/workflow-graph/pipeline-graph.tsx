/*
 * Read-only React Flow canvas for a focused workflow. The workflow is a sub-flow
 * container (WorkflowGroupNode) holding its step children; the events and router
 * rules that trigger it sit in lanes to the left and connect in. Pan/zoom for
 * inspection only — there is no editing.
 */

import "@xyflow/react/dist/style.css";

import { useMemo } from "react";

import type { WorkflowGraph } from "@fragno-dev/workflow-visualizer";

import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react";
import type { NodeTypes } from "@xyflow/react";

import {
  LOOP_GROUP_TYPE,
  PIPELINE_NODE_TYPE,
  WORKFLOW_GROUP_TYPE,
  buildFlowElements,
  type NodeRunState,
} from "./flow";
import { LoopGroupNode } from "./loop-group-node";
import { PipelineNode } from "./pipeline-node";
import { WorkflowGroupNode } from "./workflow-group-node";

const nodeTypes: NodeTypes = {
  [PIPELINE_NODE_TYPE]: PipelineNode,
  [WORKFLOW_GROUP_TYPE]: WorkflowGroupNode,
  [LOOP_GROUP_TYPE]: LoopGroupNode,
};

const flowTheme = {
  "--xy-background-color": "var(--cad-bg-2)",
  "--xy-edge-stroke": "var(--cad-line-strong)",
  "--xy-edge-stroke-selected": "var(--cad-brass)",
  "--xy-controls-button-background-color": "var(--cad-panel)",
  "--xy-controls-button-background-color-hover": "var(--cad-panel-hover)",
  "--xy-controls-button-color": "var(--cad-muted)",
  "--xy-controls-button-border-color": "var(--cad-line)",
} as React.CSSProperties;

export function PipelineGraph({
  graph,
  runState,
}: {
  graph: WorkflowGraph;
  /** node id -> live run state; when present, nodes are decorated accordingly. */
  runState?: Map<string, NodeRunState>;
}) {
  // Layout is pure and depends only on the graph, so geometry never recomputes
  // on a run tick.
  const { nodes: baseNodes, edges } = useMemo(() => buildFlowElements(graph), [graph]);

  // A second, cheap pass injects run state into node `data`. Only the node
  // objects whose run state changed are re-created; React Flow diffs by id.
  const nodes = useMemo(() => {
    if (!runState || runState.size === 0) {
      return baseNodes;
    }
    return baseNodes.map((node) => {
      const run = runState.get(node.id);
      return run ? { ...node, data: { ...node.data, run } } : node;
    });
  }, [baseNodes, runState]);

  return (
    <div className="h-full min-h-0 w-full" style={flowTheme}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesFocusable={false}
        // React Flow's pan-activation key defaults to Space and registers a
        // window-level keydown listener that preventDefault()s the spacebar.
        // Its input guard only spares <textarea>/<input>, but Monaco 0.54+
        // edits inside a `native-edit-context` <div> (EditContext API), so in
        // split view that listener swallows every space typed into the editor.
        // Panning here is drag-only, so we don't need the key at all.
        panActivationKeyCode={null}
        fitView
        // Cap the initial fit-to-view zoom so small graphs (a workflow with
        // only a couple of steps) don't blow the nodes up to fill the viewport.
        // maxZoom 1 keeps nodes at their designed pixel size; minZoom lets large
        // graphs still shrink to fit.
        fitViewOptions={{ maxZoom: 1, minZoom: 0.2 }}
        proOptions={{ hideAttribution: true }}
        className="bg-[var(--cad-bg-2)]"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.6}
          color="oklch(0.82 0.008 64)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
