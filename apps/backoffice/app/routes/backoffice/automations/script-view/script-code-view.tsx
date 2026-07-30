import { useEffect, useRef } from "react";

import type { SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import type { LinkedScrollViewport } from "./linked-scroll";

export function ScriptCodeView({
  script,
  split,
  selectedSource,
  scrollViewport,
  fillHeight = false,
  onSourceReveal,
}: {
  script: string;
  split: boolean;
  selectedSource?: SourceRange;
  scrollViewport: LinkedScrollViewport;
  fillHeight?: boolean;
  onSourceReveal: () => void;
}) {
  const selectionRef = useRef<HTMLElement>(null);
  const selectionStart = Math.max(0, Math.min(script.length, selectedSource?.start.offset ?? 0));
  const selectionEnd = Math.max(
    selectionStart,
    Math.min(script.length, selectedSource?.end.offset ?? selectionStart),
  );
  const hasSelection = selectionEnd > selectionStart;

  useEffect(() => {
    if (hasSelection) {
      onSourceReveal();
      selectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [hasSelection, onSourceReveal, selectionStart, selectionEnd]);

  return (
    <div
      {...scrollViewport}
      tabIndex={0}
      aria-label="Script source"
      className={`backoffice-scroll overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--bo-accent)] ${fillHeight ? "h-full min-h-0" : "max-h-[calc(100vh-10rem)] min-h-[36rem]"} ${split ? "border-b border-[color:var(--bo-border)] lg:border-r lg:border-b-0" : ""}`}
    >
      <pre className="min-h-full px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
        <code>
          {script ? (
            hasSelection ? (
              <>
                {script.slice(0, selectionStart)}
                <mark
                  ref={selectionRef}
                  className="bg-amber-300/35 text-inherit outline outline-1 outline-amber-500/50 dark:bg-amber-300/20"
                >
                  {script.slice(selectionStart, selectionEnd)}
                </mark>
                {script.slice(selectionEnd)}
              </>
            ) : (
              script
            )
          ) : (
            "# Empty script"
          )}
        </code>
      </pre>
    </div>
  );
}
