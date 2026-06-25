/*
 * The block renderer registry — the heart of the "single output stream"
 * capability. It maps each `ComposeBlock["type"]` to a component that renders
 * that block. `BlockRenderer` looks a block up by its discriminant and renders
 * it; an unknown type degrades to a visible fallback rather than crashing the
 * whole stream.
 *
 * Adding a new kind of output is a three-line change: add a member to
 * `composeBlockSchema` (output-model), write its renderer, and register it here.
 * Nothing else in the stream needs to know.
 */

import type { ComposeBlock, ComposeBlockType } from "../output-model";
import { ChartBlockView } from "./chart-block";
import { TableBlockView } from "./table-block";
import { TextBlockView } from "./text-block";
import { WorkflowBlockView } from "./workflow-block";

/** A renderer for one concrete block variant. */
type BlockComponent<TType extends ComposeBlockType> = (props: {
  block: Extract<ComposeBlock, { type: TType }>;
}) => React.ReactNode;

/** One entry per `ComposeBlockType` — exhaustiveness enforced by the mapped type. */
const BLOCK_RENDERERS: { [K in ComposeBlockType]: BlockComponent<K> } = {
  text: TextBlockView,
  table: TableBlockView,
  chart: ChartBlockView,
  workflow: WorkflowBlockView,
};

export function BlockRenderer({ block }: { block: ComposeBlock }) {
  const Renderer = BLOCK_RENDERERS[block.type] as BlockComponent<ComposeBlockType> | undefined;

  if (!Renderer) {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--cad-line)] px-3 py-2 text-xs text-[var(--cad-muted-2)]">
        Unsupported output block: {(block as { type: string }).type}
      </div>
    );
  }

  return <Renderer block={block} />;
}
