/*
 * The text block — prose / markdown, the default narrative output of a compose
 * run. Rendered with Streamdown, which tolerates partial markdown (so it stays
 * legible while a response streams in) and matches the rest of the app's
 * markdown rendering.
 */

import { Streamdown } from "streamdown";

import type { TextBlock } from "../output-model";

export function TextBlockView({ block }: { block: TextBlock }) {
  return (
    <div className="cad-prose max-w-none text-[15px] leading-relaxed text-[var(--cad-fg)]">
      <Streamdown>{block.markdown}</Streamdown>
    </div>
  );
}
