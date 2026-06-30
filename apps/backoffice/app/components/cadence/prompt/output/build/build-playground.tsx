/*
 * Build playground — the lightweight editor for drafted compose workflows.
 *
 * This works with the prompt output's design-time graph model (not the real
 * `@fragno-dev/workflow-visualizer` graph). It intentionally keeps the editing
 * surface small: users can inspect the generated graph and tweak node copy
 * before returning to the stream.
 */

import { X } from "lucide-react";
import type { ChangeEvent } from "react";

import { CadenceGhostButton } from "@/components/cadence/primitives";
import { cn } from "@/lib/utils";

import { NODE_KIND_META } from "../node-kinds";
import type { WorkflowGraph, WorkflowNode } from "../output-model";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 92;

export function BuildPlayground({
  graph,
  title = "Build",
  onChange,
  onClose,
}: {
  graph: WorkflowGraph;
  title?: string;
  onChange: (graph: WorkflowGraph) => void;
  onClose: () => void;
}) {
  const width = Math.max(720, ...graph.nodes.map((node) => node.position.x + NODE_WIDTH + 120));
  const height = Math.max(360, ...graph.nodes.map((node) => node.position.y + NODE_HEIGHT + 120));

  const updateNode = (
    nodeId: string,
    patch: Partial<Pick<WorkflowNode, "label" | "description">>,
  ) => {
    onChange({
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--cad-bg)]">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-5 py-3">
        <div className="min-w-0">
          <p className="cad-eyebrow text-[var(--cad-muted-2)]">Build playground</p>
          <h2 className="cad-display truncate text-lg text-[var(--cad-fg)]">{title}</h2>
        </div>
        <CadenceGhostButton type="button" className="px-3 py-2" onClick={onClose}>
          <X className="h-4 w-4" />
          Close
        </CadenceGhostButton>
      </header>

      {graph.nodes.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-5">
          <p className="text-sm text-[var(--cad-muted)]">No workflow nodes to edit yet.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="cad-scroll min-w-0 flex-1 overflow-auto p-5">
            <div
              className="relative rounded-2xl border border-[color:var(--cad-line)] bg-[radial-gradient(circle_at_1px_1px,var(--cad-line)_1px,transparent_0)] [background-size:24px_24px]"
              style={{ width, height }}
            >
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                {graph.edges.map((edge) => {
                  const source = graph.nodes.find((node) => node.id === edge.source);
                  const target = graph.nodes.find((node) => node.id === edge.target);
                  if (!source || !target) {
                    return null;
                  }
                  const startX = source.position.x + NODE_WIDTH;
                  const startY = source.position.y + NODE_HEIGHT / 2;
                  const endX = target.position.x;
                  const endY = target.position.y + NODE_HEIGHT / 2;
                  const midX = startX + Math.max(40, (endX - startX) / 2);
                  return (
                    <g key={edge.id}>
                      <path
                        d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                        fill="none"
                        stroke="var(--cad-line-strong)"
                        strokeWidth="2"
                      />
                      <circle cx={endX} cy={endY} r="4" fill="var(--cad-brass)" />
                    </g>
                  );
                })}
              </svg>

              {graph.nodes.map((node) => (
                <BuildNode key={node.id} node={node} onChange={updateNode} />
              ))}
            </div>
          </div>

          <aside className="cad-scroll hidden w-80 shrink-0 overflow-y-auto border-l border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-4 lg:block">
            <p className="cad-eyebrow text-[var(--cad-muted-2)]">Steps</p>
            <ol className="mt-3 space-y-2">
              {graph.nodes.map((node, index) => {
                const meta = NODE_KIND_META[node.kind];
                const Icon = meta.icon;
                return (
                  <li
                    key={node.id}
                    className="rounded-xl border border-[color:var(--cad-line)] p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--cad-muted-2)] tabular-nums">
                        {index + 1}
                      </span>
                      <Icon className="h-3.5 w-3.5" style={{ color: meta.accent }} />
                      <span className="text-xs font-semibold text-[var(--cad-muted)]">
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-[var(--cad-fg)]">{node.label}</p>
                  </li>
                );
              })}
            </ol>
          </aside>
        </div>
      )}
    </section>
  );
}

function BuildNode({
  node,
  onChange,
}: {
  node: WorkflowNode;
  onChange: (nodeId: string, patch: Partial<Pick<WorkflowNode, "label" | "description">>) => void;
}) {
  const meta = NODE_KIND_META[node.kind];
  const Icon = meta.icon;

  const onLabelChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(node.id, { label: event.target.value });
  };

  const onDescriptionChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(node.id, { description: event.target.value });
  };

  return (
    <article
      className={cn(
        "absolute rounded-xl border bg-[var(--cad-panel)] p-3 shadow-[var(--cad-shadow)]",
        "focus-within:ring-2 focus-within:ring-[var(--cad-brass)]/25",
      )}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: NODE_WIDTH,
        borderColor: meta.accent,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: meta.accentBg }}
        >
          <Icon className="h-4 w-4" style={{ color: meta.accent }} />
        </span>
        <span className="cad-eyebrow text-[var(--cad-muted)]">{meta.label}</span>
      </div>

      <label className="mt-3 block">
        <span className="sr-only">Node label</span>
        <input
          value={node.label}
          onChange={onLabelChange}
          className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-sm font-semibold text-[var(--cad-fg)] transition-colors outline-none hover:border-[color:var(--cad-line)] focus:border-[color:var(--cad-brass)] focus:bg-[var(--cad-bg)]"
        />
      </label>
      <label className="mt-1 block">
        <span className="sr-only">Node description</span>
        <input
          value={node.description ?? ""}
          placeholder="Add detail…"
          onChange={onDescriptionChange}
          className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-xs text-[var(--cad-muted)] transition-colors outline-none placeholder:text-[var(--cad-muted-2)] hover:border-[color:var(--cad-line)] focus:border-[color:var(--cad-brass)] focus:bg-[var(--cad-bg)]"
        />
      </label>
    </article>
  );
}
