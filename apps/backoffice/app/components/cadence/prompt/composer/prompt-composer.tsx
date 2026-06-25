/*
 * Compose mode: the plain-language surface. Describe an automation and Cadence
 * drafts it. Typing a leading `/` is the keyboard gesture for switching to the
 * dev console — the typed text is handed over as the command-line seed so the
 * slash isn't lost.
 *
 * This is intentionally the lighter of the two modes for now; the dev console is
 * where the current effort is going.
 */

import { ArrowUp, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CadenceButton, CadencePanel } from "@/components/cadence/primitives";

import { usePrompt } from "../prompt-context";
import { PromptModeToggle } from "../prompt-mode-toggle";

export function PromptComposer() {
  const { enterDev, consumeComposeFocus, conduct } = usePrompt();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // When we land here after leaving dev mode, take focus. The flag is only set by
  // exitDev, so this never steals focus on the initial page load.
  useEffect(() => {
    if (consumeComposeFocus()) {
      textareaRef.current?.focus();
    }
  }, [consumeComposeFocus]);

  function handleChange(next: string) {
    // A leading slash is the gesture for "I want the terminal" — jump to the dev
    // console. The slash itself is consumed; the terminal opens empty.
    if (next.startsWith("/")) {
      enterDev();
      return;
    }
    setValue(next);
  }

  function handleConduct() {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    conduct(trimmed);
    setValue("");
  }

  return (
    <CadencePanel className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--cad-line)] px-5 py-3">
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--cad-brass)]" />
          <span className="cad-eyebrow text-[var(--cad-muted)]">Compose a new automation</span>
        </span>
        <PromptModeToggle />
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            handleConduct();
          }
        }}
        rows={5}
        placeholder="e.g. When a customer cancels, survey them, revoke access at period end, and flag the account for win-back."
        className="cad-scroll block w-full resize-none bg-transparent px-5 py-4 text-sm leading-relaxed text-[var(--cad-fg)] placeholder:text-[var(--cad-muted-2)] focus:outline-none"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--cad-line)] px-5 py-3">
        <span className="cad-mono text-xs text-[var(--cad-muted-2)]">
          ⌘↵ to conduct · / for the dev console
        </span>
        <CadenceButton
          type="button"
          onClick={handleConduct}
          disabled={!value.trim()}
          className="gap-1.5 px-3 py-1.5 text-xs"
        >
          Conduct
          <ArrowUp className="h-3.5 w-3.5" />
        </CadenceButton>
      </div>
    </CadencePanel>
  );
}
