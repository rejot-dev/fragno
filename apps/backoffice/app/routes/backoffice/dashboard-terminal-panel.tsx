import {
  TerminalBanner,
  TerminalLog,
  TerminalLogEntry,
  TerminalLogPending,
  TerminalPrompt,
  TerminalSuggestion,
  TerminalSuggestions,
} from "@fragno-private/design-system/terminal";
import { useCallback, useEffect, useId, useMemo } from "react";
import { useFetcher } from "react-router";

import {
  type DashboardCommandResult,
  type DashboardCommandSpec,
  type DashboardAutocompleteSuggestion,
  type DashboardPathAutocompleteRequest,
  type DashboardTerminalActionResult,
  type DashboardTerminalScope,
  DASHBOARD_USE_COMMAND_SPEC,
  resolveDashboardUseCommand,
  useDashboardTerminal,
} from "./dashboard-terminal";

type DashboardTerminalPanelProps = {
  scope: DashboardTerminalScope;
  scopes: readonly DashboardTerminalScope[];
  commandSpecs: readonly DashboardCommandSpec[];
  focusInput: boolean;
  onSwitchScope: (scope: DashboardTerminalScope, command: string) => void;
  onOpenScopeMenu: () => void;
};

const suggestionKindLabel = (suggestion: DashboardAutocompleteSuggestion) => {
  if (suggestion.kind === "argument") {
    return "arg";
  }
  return suggestion.kind;
};

/** The terminal session inside a `TerminalOverlay`: scrollback, command line, and suggestions. */
export function DashboardTerminalPanel({
  scope,
  scopes,
  commandSpecs,
  focusInput,
  onSwitchScope,
  onOpenScopeMenu,
}: DashboardTerminalPanelProps) {
  const commandFetcher = useFetcher<DashboardTerminalActionResult>();
  const pathAutocompleteFetcher = useFetcher<DashboardTerminalActionResult>();
  const pathAutocompleteSubmit = pathAutocompleteFetcher.submit;
  const isSubmitting = commandFetcher.state !== "idle";
  const pendingCommand = commandFetcher.formData?.get("command");
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
      void pathAutocompleteSubmit(formData, { method: "post", action: scope.actionPath });
    },
    [scope.actionPath, pathAutocompleteSubmit],
  );
  const allCommandSpecs = useMemo(
    () => [DASHBOARD_USE_COMMAND_SPEC, ...commandSpecs],
    [commandSpecs],
  );
  const terminal = useDashboardTerminal({
    scopeId: scope.actionPath,
    scopeName: scope.label,
    result: commandResult,
    pathAutocompleteResult,
    requestPathAutocomplete,
    disabled: isSubmitting,
    commandSpecs: allCommandSpecs,
    scopes,
  });
  const autocompleteListId = useId();

  useEffect(() => {
    if (focusInput) {
      terminal.inputRef.current?.focus();
    }
  }, [focusInput, terminal.inputRef]);

  useEffect(() => {
    const log = terminal.terminalRef.current;
    if (log && typeof pendingCommand === "string") {
      log.scrollTop = log.scrollHeight;
    }
  }, [pendingCommand, terminal.terminalRef]);

  return (
    <>
      <TerminalLog ref={terminal.terminalRef}>
        {terminal.terminalHistory.map((entry) =>
          // Only the greeting has no command.
          entry.command === "" ? (
            <TerminalBanner key={entry.id}>{entry.output}</TerminalBanner>
          ) : (
            <TerminalLogEntry
              key={entry.id}
              timestamp={entry.timestamp}
              cwd={entry.cwd}
              command={entry.command}
              output={entry.output}
              ok={entry.ok}
              exitCode={entry.exitCode}
              durationMs={entry.durationMs}
            />
          ),
        )}
        {typeof pendingCommand === "string" ? (
          <TerminalLogPending cwd={terminal.currentCwd} command={pendingCommand} />
        ) : null}
      </TerminalLog>

      <commandFetcher.Form
        method="post"
        action={scope.actionPath}
        onSubmit={(event) => {
          if (terminal.command.trim() === "") {
            event.preventDefault();
            return;
          }
          const use = resolveDashboardUseCommand({
            command: terminal.command,
            cwd: terminal.currentCwd,
            scopes,
            current: scope,
          });
          if (use.kind === "not-use") {
            return;
          }
          event.preventDefault();
          if (use.kind === "switch") {
            onSwitchScope(use.scope, terminal.command.trim());
          } else {
            terminal.reply(use.result);
          }
        }}
      >
        <input type="hidden" name="intent" value="run-command" />
        <input type="hidden" name="cwd" value={terminal.currentCwd} />
        <TerminalPrompt
          scope={scope.name}
          cwd={terminal.currentCwd}
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
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape" || !terminal.autocompleteOpen) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            terminal.closeAutocomplete();
          }}
          onKeyDown={(event) => {
            if (event.ctrlKey && event.key === "o") {
              event.preventDefault();
              onOpenScopeMenu();
              return;
            }
            terminal.onCommandKeyDown(event);
          }}
          placeholder="Run a bash command (e.g. ls /workspace, pwd, find /static)"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={isSubmitting}
        />
      </commandFetcher.Form>

      {terminal.autocompleteOpen ? (
        <TerminalSuggestions
          id={autocompleteListId}
          label={terminal.autocompleteMode === "history" ? "Command history" : "Suggestions"}
        >
          {terminal.autocompleteSuggestions.map((suggestion, index) => (
            <TerminalSuggestion
              key={suggestion.id}
              id={`${autocompleteListId}-option-${index}`}
              kind={suggestionKindLabel(suggestion)}
              label={suggestion.label}
              description={
                suggestion.detail
                  ? `${suggestion.detail} · ${suggestion.description}`
                  : suggestion.description
              }
              active={index === terminal.activeAutocompleteIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                terminal.onAutocompleteSuggestionMouseDown(suggestion);
              }}
            />
          ))}
        </TerminalSuggestions>
      ) : null}
    </>
  );
}
