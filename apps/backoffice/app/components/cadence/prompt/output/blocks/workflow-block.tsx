/*
 * The workflow preview block — a compact summary card for a drafted workflow. It
 * shows the ordered steps and a count of nodes/edges, and offers a single
 * obvious action: open the graph in the build-mode playground, where it becomes
 * editable. The card itself is read-only.
 */

import { Workflow } from "lucide-react";

import { CadenceButton } from "@/components/cadence/primitives";

import { NODE_KIND_META } from "../node-kinds";
import { useOutputActions } from "../output-actions";
import type { WorkflowBlock } from "../output-model";
import { BlockFrame } from "./block-frame";

export function WorkflowBlockView({ block }: { block: WorkflowBlock }) {
  const { openBuild } = useOutputActions();
  const { graph } = block;

  return (
    <BlockFrame>
      <div className="rounded-xl border border-[color:var(--cad-brass-line)] bg-[var(--cad-brass-bg)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="cad-eyebrow flex items-center gap-1.5 text-[var(--cad-brass-strong)]">
              <Workflow className="h-3 w-3" />
              Drafted workflow
            </p>
            <h3 className="cad-display mt-1 text-lg text-[var(--cad-fg)]">{block.title}</h3>
            {block.summary ? (
              <p className="mt-1 text-sm text-[var(--cad-muted)]">{block.summary}</p>
            ) : null}
          </div>
          <CadenceButton
            type="button"
            className="shrink-0"
            onClick={() => {
              openBuild({ graph, title: block.title, sourceBlockId: block.id });
            }}
          >
            Open in build
          </CadenceButton>
        </div>

        {/* Ordered step chips. */}
        <ol className="mt-3 flex flex-wrap items-center gap-1.5">
          {graph.nodes.map((node, index) => {
            const meta = NODE_KIND_META[node.kind];
            const Icon = meta.icon;
            return (
              <li key={node.id} className="flex items-center gap-1.5">
                {index > 0 ? <span className="text-[var(--cad-muted-2)]">→</span> : null}
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-[var(--cad-fg)]"
                  style={{ borderColor: meta.accent, background: "var(--cad-panel)" }}
                >
                  <Icon className="h-3 w-3" style={{ color: meta.accent }} />
                  {node.label}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-3 text-xs text-[var(--cad-muted-2)]">
          {graph.nodes.length} steps · {graph.edges.length} connections
        </p>
      </div>
    </BlockFrame>
  );
}
