import { useEffect, useRef } from "react";
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
  organizationId?: string | null;
  organizationName?: string | null;
  commandSpecs?: readonly DashboardCommandSpec[];
};

const suggestionKindLabel = (suggestion: DashboardAutocompleteSuggestion) => {
  if (suggestion.kind === "argument") {
    return "arg";
  }
  return suggestion.kind;
};

export function DashboardTerminalPanel({
  organizationId,
  organizationName,
  commandSpecs = [],
}: DashboardTerminalPanelProps) {
  const commandFetcher = useFetcher<DashboardTerminalActionResult>();
  const pathAutocompleteFetcher = useFetcher<DashboardTerminalActionResult>();
  const isSubmitting = commandFetcher.state !== "idle";
  const commandResult: DashboardCommandResult | undefined =
    commandFetcher.data?.intent === "run-command" ? commandFetcher.data : undefined;
  const pathAutocompleteResult =
    pathAutocompleteFetcher.data?.intent === "autocomplete-path"
      ? pathAutocompleteFetcher.data
      : undefined;
  const requestPathAutocomplete = (request: DashboardPathAutocompleteRequest) => {
    const formData = new FormData();
    formData.set("intent", request.intent);
    formData.set("commandLine", request.commandLine);
    formData.set("cwd", request.cwd);
    formData.set("cursorPosition", String(request.cursorPosition));
    pathAutocompleteFetcher.submit(formData, { method: "post" });
  };
  const terminal = useDashboardTerminal({
    organizationId,
    organizationName,
    result: commandResult,
    pathAutocompleteResult,
    requestPathAutocomplete,
    disabled: isSubmitting,
    commandSpecs,
  });
  const autocompleteListRef = useRef<HTMLDivElement>(null);
  const autocompleteItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Pi terminal
          </p>
          <p className="text-sm text-[var(--bo-muted)]">
            Command output is executed against the backoffice Pi-backed filesystem (/system,
            /workspace).
          </p>
        </div>
        <p className="text-right text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          ^J run · ^L clear · ^R history · Tab complete
        </p>
      </div>

      <div
        ref={terminal.terminalRef}
        className="backoffice-scroll mt-4 max-h-[28rem] max-w-full min-w-0 overflow-auto rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-xs leading-6 text-[var(--bo-fg)]"
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

      <commandFetcher.Form method="post" className="mt-4 space-y-2">
        <div className="flex gap-2">
          <input type="hidden" name="intent" value="run-command" />
          <input type="hidden" name="cwd" value={terminal.currentCwd} />
          <div className="relative flex min-w-0 flex-1 items-stretch border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
            {terminal.autocompleteOpen ? (
              <div className="absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] shadow-2xl shadow-black/30">
                <div className="flex items-center justify-between border-b border-[color:var(--bo-border)] px-3 py-2">
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    {terminal.autocompleteMode === "history" ? "Command history" : "Completions"}
                  </p>
                  <p className="text-[10px] text-[var(--bo-muted-2)]">
                    ↑↓ select · Enter/Tab apply
                  </p>
                </div>
                <div ref={autocompleteListRef} className="max-h-64 overflow-auto py-1">
                  {terminal.autocompleteSuggestions.map((suggestion, index) => {
                    const isActive = index === terminal.activeAutocompleteIndex;
                    return (
                      <button
                        key={suggestion.id}
                        ref={(node) => {
                          autocompleteItemRefs.current[index] = node;
                        }}
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          terminal.onAutocompleteSuggestionMouseDown(suggestion);
                        }}
                        className={`flex w-full items-start gap-3 px-3 py-2 text-left font-mono text-xs transition-colors ${
                          isActive
                            ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
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
            ) : null}

            <div
              title={terminal.currentCwd}
              className="w-72 max-w-[42%] shrink-0 overflow-hidden border-r border-[color:var(--bo-border)] px-3 py-2 font-mono text-sm text-ellipsis whitespace-nowrap text-[var(--bo-accent-fg)] lg:w-96"
            >
              {shortenDashboardCwd(terminal.currentCwd, 44)}
            </div>
            <input
              ref={terminal.inputRef}
              name="command"
              value={terminal.command}
              onChange={(event) => terminal.onCommandChange(event.target.value)}
              onKeyDown={terminal.onCommandKeyDown}
              placeholder="Run a bash command (e.g. ls /workspace, pwd, find /system)"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-[var(--bo-fg)] outline-none"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSubmitting}
            />
          </div>
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
        </div>

        {terminal.argumentHints.length > 0 ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2">
            <p className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Available arguments
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {terminal.argumentHints.map((option) => (
                <div
                  key={option.name}
                  className={`max-w-full border px-2 py-1 text-xs ${
                    option.used
                      ? "border-[color:var(--bo-border)] text-[var(--bo-muted-2)] line-through opacity-60"
                      : "border-[color:var(--bo-border-strong)] text-[var(--bo-fg)]"
                  }`}
                  title={option.description}
                >
                  <span className="font-mono">--{option.name}</span>
                  {option.valueRequired ? (
                    <span className="font-mono text-[var(--bo-muted)]">
                      {" "}
                      &lt;{option.valueName ?? "value"}&gt;
                    </span>
                  ) : null}
                  {option.required ? (
                    <span className="ml-2 text-[9px] tracking-[0.16em] text-[var(--bo-accent-fg)] uppercase">
                      required
                    </span>
                  ) : null}
                  <span className="ml-2 text-[var(--bo-muted)]">{option.description}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </commandFetcher.Form>
    </div>
  );
}
