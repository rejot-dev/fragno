/*
 * Dev mode input: the command line for the bash terminal against the Pi
 * filesystem. The transcript it produces lives in `<PromptOutput>` (the large
 * block on top); this is just the input row, its argument hints, and the
 * autocomplete popup.
 *
 * The terminal session itself (`useDashboardTerminal`, the command fetcher, cwd
 * tracking, history) lives in `PromptProvider` so the output block can share it.
 * Submitting posts to the host route's `action` (see `handlePiTerminalAction`),
 * scoped to the active organisation.
 */

import { CornerDownLeft } from "lucide-react";
import { useEffect } from "react";

import { CadencePanel } from "@/components/cadence/primitives";
import { cn } from "@/lib/utils";
import { shortenDashboardCwd } from "@/routes/backoffice/dashboard-terminal";

import { usePrompt } from "../prompt-context";
import { PromptModeToggle } from "../prompt-mode-toggle";
import { DevAutocompletePopup } from "./dev-autocomplete-popup";

export function DevInput() {
  const { exitDev, consumeDevFocus, organizationName, terminal, commandFetcher, isSubmitting } =
    usePrompt();

  // When we land here after entering dev mode (typing `/`, or the toggle), take
  // focus. The flag is only set by enterDev, so this never steals focus on the
  // initial page load — the composer mounts first.
  const { inputRef } = terminal;
  useEffect(() => {
    if (consumeDevFocus()) {
      inputRef.current?.focus();
    }
  }, [consumeDevFocus, inputRef]);

  // Escape is layered: if the completions popup is open it just closes that
  // (keeping you in the terminal); otherwise it leaves dev mode and hands focus
  // to the compose input (the composer picks up the focus signal when it mounts).
  // Listening on the document means this works even when focus has wandered.
  const { autocompleteOpen, closeAutocomplete } = terminal;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      if (autocompleteOpen) {
        closeAutocomplete();
        inputRef.current?.focus();
        return;
      }
      exitDev();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [autocompleteOpen, closeAutocomplete, inputRef, exitDev]);

  return (
    <CadencePanel>
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--cad-line)] px-5 py-3">
        <span className="flex items-center gap-2">
          <span className="cad-eyebrow text-[var(--cad-muted)]">
            Dev terminal{organizationName ? ` · ${organizationName}` : ""}
          </span>
        </span>
        <PromptModeToggle />
      </div>

      <commandFetcher.Form method="post" className="px-5 py-3">
        <input type="hidden" name="intent" value="run-command" />
        <input type="hidden" name="cwd" value={terminal.currentCwd} />

        <div className="relative">
          {terminal.autocompleteOpen ? (
            <DevAutocompletePopup
              suggestions={terminal.autocompleteSuggestions}
              activeIndex={terminal.activeAutocompleteIndex}
              mode={terminal.autocompleteMode}
              onSelect={terminal.onAutocompleteSuggestionMouseDown}
            />
          ) : null}

          <div className="flex items-stretch gap-2 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] focus-within:border-[color:var(--cad-brass-line)]">
            <span
              title={terminal.currentCwd}
              className="hidden max-w-[40%] shrink-0 items-center overflow-hidden border-r border-[color:var(--cad-line)] px-3 font-mono text-xs text-ellipsis whitespace-nowrap text-[var(--cad-brass)] sm:flex"
            >
              {shortenDashboardCwd(terminal.currentCwd, 36)}
            </span>
            <input
              ref={terminal.inputRef}
              name="command"
              value={terminal.command}
              onChange={(event) => {
                terminal.onCommandChange(event.target.value);
              }}
              onKeyDown={terminal.onCommandKeyDown}
              placeholder="Run a bash command (e.g. ls /workspace, pwd, find /static)"
              className="min-w-0 flex-1 bg-transparent py-2.5 pl-3 font-mono text-sm text-[var(--cad-fg)] placeholder:text-[var(--cad-muted-2)] focus:outline-none sm:pl-0"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSubmitting}
            />
            <button
              type="submit"
              disabled={isSubmitting || !terminal.command.trim()}
              className="inline-flex items-center gap-1.5 px-3 text-xs font-semibold text-[var(--cad-muted-2)] transition-colors hover:text-[var(--cad-fg)] disabled:opacity-40"
            >
              <CornerDownLeft className="h-3.5 w-3.5" />
              {isSubmitting ? "Running" : "Run"}
            </button>
          </div>
        </div>

        {terminal.argumentHints.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {terminal.argumentHints.map((hint) => (
              <span
                key={hint.name}
                title={hint.description}
                className={cn(
                  "rounded-md border px-2 py-0.5 font-mono text-[11px]",
                  hint.used
                    ? "border-[color:var(--cad-line)] text-[var(--cad-muted-2)] line-through opacity-60"
                    : "border-[color:var(--cad-line-strong)] text-[var(--cad-fg)]",
                )}
              >
                --{hint.name}
                {hint.valueRequired ? (
                  <span className="text-[var(--cad-muted)]">
                    {" "}
                    &lt;{hint.valueName ?? "value"}&gt;
                  </span>
                ) : null}
                {hint.required ? (
                  <span className="cad-eyebrow ml-1.5 text-[9px] text-[var(--cad-brass)]">req</span>
                ) : null}
              </span>
            ))}
          </div>
        ) : (
          <p className="cad-mono mt-2 text-[10px] text-[var(--cad-muted-2)]">
            ↵ run · Tab complete · ↑↓ history · ⌃R search · ⌃L clear · Esc exit
          </p>
        )}
      </commandFetcher.Form>
    </CadencePanel>
  );
}
