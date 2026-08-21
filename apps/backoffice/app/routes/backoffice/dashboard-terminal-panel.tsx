import { useCallback, useEffect, useId, useRef } from "react";
import { useFetcher } from "react-router";

import {
  type DashboardCommandResult,
  type DashboardCommandSpec,
  type DashboardAutocompleteSuggestion,
  type DashboardPathAutocompleteRequest,
  type DashboardTerminalActionResult,
  shortenDashboardCwd,
  useDashboardTerminal,
} from "./dashboard-terminal";

type DashboardTerminalPanelProps = {
  scopeId?: string | null;
  scopeName?: string | null;
  description?: string;
  commandSpecs?: readonly DashboardCommandSpec[];
  actionPath?: string;
  presentation?: "page" | "quake";
  focusInput?: boolean;
};

const suggestionKindLabel = (suggestion: DashboardAutocompleteSuggestion) => {
  if (suggestion.kind === "argument") {
    return "arg";
  }
  return suggestion.kind;
};

export function DashboardTerminalPanel({
  scopeId,
  scopeName,
  description = "Command output is executed against the backoffice Pi-backed filesystem (/static, /workspace).",
  commandSpecs = [],
  actionPath,
  presentation = "page",
  focusInput = false,
}: DashboardTerminalPanelProps) {
  const commandFetcher = useFetcher<DashboardTerminalActionResult>();
  const pathAutocompleteFetcher = useFetcher<DashboardTerminalActionResult>();
  const pathAutocompleteSubmit = pathAutocompleteFetcher.submit;
  const isSubmitting = commandFetcher.state !== "idle";
  const commandResult: DashboardCommandResult | undefined =
    commandFetcher.data?.intent === "run-command" ? commandFetcher.data : undefined;
  const pathAutocompleteResult =
    pathAutocompleteFetcher.data?.intent === "autocomplete-path"
      ? pathAutocompleteFetcher.data
      : undefined;
  const requestPathAutocomplete = useCallback(
    (request: DashboardPathAutocompleteRequest) => {
      const formData = new FormData();
      formData.set("intent", request.intent);
      formData.set("commandLine", request.commandLine);
      formData.set("cwd", request.cwd);
      formData.set("cursorPosition", String(request.cursorPosition));
      void pathAutocompleteSubmit(formData, { method: "post", action: actionPath });
    },
    [actionPath, pathAutocompleteSubmit],
  );
  const terminal = useDashboardTerminal({
    scopeId,
    scopeName,
    result: commandResult,
    pathAutocompleteResult,
    requestPathAutocomplete,
    disabled: isSubmitting,
    commandSpecs,
  });
  const autocompleteListId = useId();
  const autocompleteListRef = useRef<HTMLDivElement>(null);
  const autocompleteItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (focusInput) {
      terminal.inputRef.current?.focus();
    }
  }, [focusInput, terminal.inputRef]);

  useEffect(() => {
    if (!terminal.autocompleteOpen) {
      return;
    }

    const list = autocompleteListRef.current;
    const item = autocompleteItemRefs.current[terminal.activeAutocompleteIndex];
    if (!list || !item) {
      return;
    }

    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;

    if (itemTop < visibleTop) {
      list.scrollTop = itemTop;
      return;
    }

    if (itemBottom > visibleBottom) {
      list.scrollTop = itemBottom - list.clientHeight;
    }
  }, [terminal.activeAutocompleteIndex, terminal.autocompleteOpen]);

  const isQuakeTerminal = presentation === "quake";

  function renderAutocompleteMenu(positionClassName: string) {
    return (
      <div
        className={`absolute z-20 overflow-hidden border border-[color:var(--bo-border-strong)] bg-[color:color-mix(in_srgb,var(--bo-panel)_88%,transparent)] shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-3xl ${positionClassName}`}
      >
        {!isQuakeTerminal ? (
          <div className="flex items-center justify-between border-b border-[color:var(--bo-border)] px-3 py-2">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              {terminal.autocompleteMode === "history" ? "Command history" : "Completions"}
            </p>
            <p className="text-[10px] text-[var(--bo-muted-2)]">↑↓ select · Enter/Tab apply</p>
          </div>
        ) : null}
        <div
          id={autocompleteListId}
          ref={autocompleteListRef}
          role="listbox"
          aria-label={terminal.autocompleteMode === "history" ? "Command history" : "Suggestions"}
          className={
            isQuakeTerminal
              ? "max-h-[min(18rem,40vh)] overflow-auto py-1"
              : "max-h-64 overflow-auto py-1"
          }
        >
          {terminal.autocompleteSuggestions.map((suggestion, index) => {
            const isActive = index === terminal.activeAutocompleteIndex;
            return (
              <button
                key={suggestion.id}
                id={`${autocompleteListId}-option-${index}`}
                ref={(node) => {
                  autocompleteItemRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseDown={(event) => {
                  event.preventDefault();
                  terminal.onAutocompleteSuggestionMouseDown(suggestion);
                }}
                className={`flex w-full items-start gap-3 px-3 py-2 text-left font-mono text-xs transition-colors ${
                  isActive
                    ? "bg-[var(--bo-accent-bg)] font-semibold text-[var(--bo-accent-fg)] shadow-[inset_3px_0_0_var(--bo-accent)]"
                    : "text-[var(--bo-fg)] hover:bg-[var(--bo-panel-2)]"
                }`}
              >
                <span className="mt-0.5 min-w-16 text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                  {suggestionKindLabel(suggestion)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{suggestion.label}</span>
                  <span className="mt-1 block truncate font-sans text-[11px] text-[var(--bo-muted)]">
                    {suggestion.detail ? `${suggestion.detail} · ` : ""}
                    {suggestion.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        isQuakeTerminal
          ? "relative flex min-h-0 min-w-0 flex-1 flex-col bg-transparent"
          : "min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
      }
    >
      {!isQuakeTerminal ? (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Pi terminal
            </p>
            <p className="text-sm text-[var(--bo-muted)]">{description}</p>
          </div>
          <p className="text-right text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            ^J run · ^L clear · ^R history · Tab complete
          </p>
        </div>
      ) : null}

      <div
        ref={terminal.terminalRef}
        className={`backoffice-scroll max-w-full min-w-0 overflow-auto font-mono text-xs leading-6 text-[var(--bo-fg)] ${
          isQuakeTerminal
            ? "min-h-0 flex-1 bg-[color:color-mix(in_srgb,var(--bo-bg)_38%,transparent)] px-5 py-3"
            : "mt-4 max-h-[28rem] rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
        }`}
      >
        {terminal.terminalHistory.map((entry) => (
          <div key={entry.id} className="mb-4 w-max min-w-full last:mb-0">
            <p className="text-[var(--bo-muted-2)]">
              [{new Date(entry.timestamp).toLocaleTimeString()}]
            </p>
            <p>
              <span className="text-[var(--bo-accent-fg)]">{entry.cwd}</span>
              <span className="text-[var(--bo-muted)]"> $ </span>
              <span className="text-[var(--bo-fg)]">{entry.command || "(system)"}</span>
            </p>
            <pre className={`whitespace-pre ${entry.ok ? "text-[var(--bo-fg)]" : "text-red-400"}`}>
              {entry.output}
            </pre>
            <p className="mt-1 text-[10px] text-[var(--bo-muted-2)] uppercase">
              exit {entry.exitCode} · {entry.durationMs}ms
            </p>
          </div>
        ))}
      </div>

      <commandFetcher.Form
        method="post"
        action={actionPath}
        className={
          isQuakeTerminal
            ? "space-y-2 bg-[color:color-mix(in_srgb,var(--bo-panel)_58%,transparent)] backdrop-blur-2xl"
            : "mt-4 space-y-2"
        }
      >
        <div className={isQuakeTerminal ? "flex" : "flex gap-2"}>
          <input type="hidden" name="intent" value="run-command" />
          <input type="hidden" name="cwd" value={terminal.currentCwd} />
          <div
            className={`relative flex min-w-0 flex-1 items-stretch ${
              isQuakeTerminal
                ? "bg-[color:color-mix(in_srgb,var(--bo-panel-2)_46%,transparent)] focus-within:bg-[color:color-mix(in_srgb,var(--bo-panel-2)_68%,transparent)]"
                : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
            }`}
          >
            {terminal.autocompleteOpen && !isQuakeTerminal
              ? renderAutocompleteMenu("right-0 bottom-full left-0 mb-2")
              : null}

            <div
              title={terminal.currentCwd}
              className={`max-w-[42%] shrink-0 overflow-hidden px-3 py-2 font-mono text-sm text-ellipsis whitespace-nowrap text-[var(--bo-accent-fg)] ${
                isQuakeTerminal ? "" : "w-72 border-r border-[color:var(--bo-border)] lg:w-96"
              }`}
            >
              {shortenDashboardCwd(terminal.currentCwd, 44)}
            </div>
            <input
              ref={terminal.inputRef}
              name="command"
              aria-label="Dashboard terminal command"
              aria-autocomplete="list"
              aria-controls={terminal.autocompleteOpen ? autocompleteListId : undefined}
              aria-expanded={terminal.autocompleteOpen}
              aria-activedescendant={
                terminal.autocompleteOpen && terminal.autocompleteSuggestions.length > 0
                  ? `${autocompleteListId}-option-${terminal.activeAutocompleteIndex}`
                  : undefined
              }
              value={terminal.command}
              onChange={(event) => {
                terminal.onCommandChange(event.target.value);
              }}
              onKeyDown={terminal.onCommandKeyDown}
              placeholder="Run a bash command (e.g. ls /workspace, pwd, find /static)"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-[var(--bo-fg)] outline-none"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSubmitting}
            />
          </div>
          {!isQuakeTerminal ? (
            <>
              <button
                type="submit"
                className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Running" : "Run"}
              </button>
              <button
                type="button"
                onClick={terminal.clear}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase"
                disabled={isSubmitting}
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      </commandFetcher.Form>

      {terminal.autocompleteOpen && isQuakeTerminal
        ? renderAutocompleteMenu("top-full left-0 mt-2 w-full")
        : null}
    </div>
  );
}
