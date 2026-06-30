/*
 * Custom React Flow node for the leaf kinds: event / router / script / step.
 * (Workflows are rendered by WorkflowGroupNode as sub-flow containers.) All
 * kinds connect top→bottom: steps stack vertically inside their workflow
 * container, and events/routers flow down through the trigger rows into it.
 */

import type { GraphNode } from "@fragno-dev/workflow-visualizer";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { FlowNodeData, PipelineFlowNode } from "./flow";
import { PIPELINE_NODE_META, STEP_TYPE_ICON, STEP_TYPE_LABEL } from "./node-meta";

// The graph is read-only (not connectable), so the handles are connection
// anchors only — keep them invisible. Showing them produced a doubled dot
// between consecutive steps where the source and target handles meet.
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

// Run-state visuals: a colored ring + glow keyed off the live step status.
const RUN_STYLE: Record<string, { color: string; pulse: boolean }> = {
  running: { color: "var(--cad-brass)", pulse: true },
  active: { color: "var(--cad-brass)", pulse: true },
  waiting: { color: "var(--cad-brass-strong)", pulse: true },
  complete: { color: "var(--cad-verdigris)", pulse: false },
  errored: { color: "var(--cad-rose)", pulse: false },
  failed: { color: "var(--cad-rose)", pulse: false },
};

export function PipelineNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const { node, run } = data as FlowNodeData;
  const meta = PIPELINE_NODE_META[node.kind];
  const Icon = node.kind === "step" ? STEP_TYPE_ICON[node.stepType] : meta.icon;
  const kindLabel = node.kind === "step" ? STEP_TYPE_LABEL[node.stepType] : meta.label;
  const isStep = node.kind === "step";

  const runStyle = run ? RUN_STYLE[run.status] : undefined;
  const borderColor = runStyle?.color ?? (selected ? meta.accent : "var(--cad-line)");
  const boxShadow = runStyle
    ? `0 0 0 2px ${runStyle.color}`
    : selected
      ? `0 0 0 2px ${meta.accent}`
      : undefined;

  return (
    <div
      className={`flex h-full w-full flex-col justify-center rounded-xl border bg-[var(--cad-panel)] px-3 py-2.5 shadow-[var(--cad-shadow)] ${
        runStyle?.pulse ? "cad-running-border" : ""
      }`}
      style={
        {
          borderColor,
          boxShadow,
          ...(runStyle?.pulse ? { "--cad-run-color": runStyle.color } : {}),
        } as React.CSSProperties
      }
    >
      <Handle
        type="target"
        id={isStep ? "step-in" : undefined}
        position={Position.Top}
        style={handleStyle}
      />

      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: meta.accentBg, color: meta.accent }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="cad-eyebrow leading-none" style={{ color: meta.accent }}>
            {kindLabel}
          </p>
          <p
            className={`text-sm font-medium break-words text-[var(--cad-fg)] ${isStep ? "line-clamp-2" : "truncate"}`}
          >
            {node.label}
          </p>
        </div>
        {run ? <RunBadge run={run} color={runStyle?.color ?? "var(--cad-muted)"} /> : null}
      </div>

      <NodeDetail node={node} />

      <Handle
        type="source"
        id={isStep ? "step-out" : undefined}
        position={Position.Bottom}
        style={handleStyle}
      />
    </div>
  );
}

function RunBadge({ run, color }: { run: NonNullable<FlowNodeData["run"]>; color: string }) {
  const title = run.error
    ? run.error
    : `${run.status}${run.attempts > 1 ? ` · attempt ${run.attempts}` : ""}`;
  return (
    <span
      title={title}
      className="cad-mono ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px]"
      style={{ color, background: "var(--cad-panel-2)" }}
    >
      {run.status}
      {run.attempts > 1 ? ` ·${run.attempts}` : ""}
      {run.emissionCount > 0 ? ` ✦${run.emissionCount}` : ""}
    </span>
  );
}

function NodeDetail({ node }: { node: GraphNode }) {
  if (node.kind === "event") {
    return (
      <p className="cad-mono mt-1.5 truncate text-[10px] text-[var(--cad-muted-2)]">
        {node.source}/{node.eventType}
      </p>
    );
  }

  if (node.kind === "script") {
    return (
      <p className="cad-mono mt-1.5 truncate text-[10px] text-[var(--cad-muted-2)]">
        {node.engine}
        {node.enabled ? "" : " · disabled"}
      </p>
    );
  }

  if (node.kind === "step") {
    const detail = stepDetail(node);
    return (
      <>
        {detail ? (
          <p className="cad-mono mt-1.5 truncate text-[10px] text-[var(--cad-muted)]">{detail}</p>
        ) : null}
        {node.stepType === "guard" && node.meta.returns ? (
          <span
            title={node.meta.returns}
            className="cad-mono mt-1.5 block truncate rounded bg-[var(--cad-panel-2)] px-1.5 py-0.5 text-[9px] text-[var(--cad-muted-2)]"
          >
            ↩ {node.meta.returns}
          </span>
        ) : null}
        {node.branch.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-1">
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
      </>
    );
  }

  return null;
}

function stepDetail(node: Extract<GraphNode, { kind: "step" }>): string | null {
  if (node.meta.condition) {
    return `if ${node.meta.condition}`;
  }
  if (node.meta.duration) {
    return `for ${node.meta.duration}`;
  }
  if (node.meta.until) {
    return `until ${node.meta.until}`;
  }
  if (node.meta.eventType) {
    return node.meta.timeout
      ? `${node.meta.eventType} · ${node.meta.timeout}`
      : node.meta.eventType;
  }
  return null;
}
