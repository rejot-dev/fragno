/*
 * The React Flow sub-flow container for a workflow. It's a sized box (width /
 * height come from the node style, computed in flow.ts) with a header; its step
 * children render inside it. A single target handle on top receives the
 * trigger edges (events / router rules) that lead down into the workflow.
 */

import { Workflow } from "lucide-react";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { PipelineFlowNode } from "./flow";

// Invisible connection anchor (read-only graph).
const handleStyle: React.CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: "none",
  background: "transparent",
  opacity: 0,
  pointerEvents: "none",
};

export function WorkflowGroupNode({ data }: NodeProps<PipelineFlowNode>) {
  const { node } = data;
  if (node.kind !== "workflow") {
    return null;
  }

  return (
    <div
      className="h-full w-full rounded-2xl border-2"
      style={{ borderColor: "var(--cad-verdigris)", background: "var(--cad-verdigris-bg)" }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />

      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-md"
          style={{ background: "var(--cad-panel)", color: "var(--cad-verdigris)" }}
        >
          <Workflow className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="cad-eyebrow leading-none" style={{ color: "var(--cad-verdigris)" }}>
            Workflow
          </p>
          <p className="truncate text-sm font-semibold text-[var(--cad-fg)]">{node.label}</p>
        </div>
        {node.remote ? (
          <span className="cad-eyebrow ml-auto rounded bg-[var(--cad-panel)] px-1.5 py-0.5 text-[9px] text-[var(--cad-muted-2)]">
            remote
          </span>
        ) : null}
      </div>
    </div>
  );
}
