/*
 * The React Flow sub-flow container for a loop block. Like WorkflowGroupNode it's
 * a sized box (geometry from flow.ts) whose step / nested-loop children render
 * inside it, but a loop also sits in its parent's sequence spine, so it carries
 * the same top/bottom step handles as a step node. The header shows the loop
 * expression and any conditions gating the loop.
 */

import { Repeat } from "lucide-react";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { FlowNodeData, PipelineFlowNode } from "./flow";

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

export function LoopGroupNode({ data }: NodeProps<PipelineFlowNode>) {
  const { node } = data as FlowNodeData;
  if (node.kind !== "loop") {
    return null;
  }

  return (
    <div
      className="h-full w-full rounded-xl border border-dashed"
      style={{ borderColor: "var(--cad-brass-strong)", background: "var(--cad-brass-bg)" }}
    >
      <Handle type="target" id="step-in" position={Position.Top} style={handleStyle} />

      <div className="flex items-start gap-2 px-3 py-2">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: "var(--cad-panel)", color: "var(--cad-brass-strong)" }}
        >
          <Repeat className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="cad-eyebrow leading-none" style={{ color: "var(--cad-brass-strong)" }}>
            Loop
          </p>
          <p
            className="cad-mono truncate text-[11px] font-medium text-[var(--cad-fg)]"
            title={node.label}
          >
            {node.label}
          </p>
          {node.branch.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1">
              {node.branch.map((condition, i) => (
                <span
                  key={i}
                  title={condition}
                  className="cad-mono block truncate rounded bg-[var(--cad-panel-2)] px-1.5 py-0.5 text-[9px] text-[var(--cad-muted-2)]"
                >
                  {condition}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <Handle type="source" id="step-out" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}
