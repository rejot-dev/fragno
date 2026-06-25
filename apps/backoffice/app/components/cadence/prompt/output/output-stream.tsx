/*
 * The stream surface — renders a compose result as a vertical, scrolling stream
 * of heterogeneous blocks. Each block is dispatched through the renderer
 * registry, so this component knows nothing about individual block types; it
 * only owns layout, spacing, and the empty/loading affordances.
 */

import { Sparkles } from "lucide-react";

import { BlockRenderer } from "./blocks/registry";
import type { ComposeBlock } from "./output-model";

export function OutputStream({
  prompt,
  blocks,
  scrollRef,
  isComposing,
}: {
  prompt?: string;
  blocks: readonly ComposeBlock[];
  scrollRef?: React.Ref<HTMLDivElement>;
  isComposing?: boolean;
}) {
  return (
    <div ref={scrollRef} className="cad-scroll min-h-0 flex-1 overflow-auto px-5 py-5">
      {prompt ? (
        <p className="mb-4 flex items-start gap-2 text-xs text-[var(--cad-muted)]">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cad-brass)]" />
          <span className="italic">“{prompt}”</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-5">
        {blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} />
        ))}
      </div>

      {isComposing ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-[var(--cad-muted-2)]">
          <span className="cad-pulse inline-block h-2 w-2 rounded-full bg-[var(--cad-brass)]" />
          Composing…
        </p>
      ) : null}
    </div>
  );
}
