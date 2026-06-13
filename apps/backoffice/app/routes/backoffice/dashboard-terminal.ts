import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";

const DASHBOARD_CWD_MARKER = "__FRAGNO_BACKOFFICE_CWD__";
const DASHBOARD_TERMINAL_STORAGE_KEY = "backoffice.dashboard.terminal";
const MAX_HISTORY = 80;
const MAX_AUTOCOMPLETE_SUGGESTIONS = 8;

export const DEFAULT_CWD = "/";
export const DASHBOARD_COMMAND_TIMEOUT_MS = 15_000;

export type DashboardTerminalEntry = {
  id: string;
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  timestamp: string;
};

export type DashboardCommandResult = {
  intent: "run-command";
  command: string;
  cwd: string;
  nextCwd: string;
  output: string;
  exitCode: number;
  durationMs: number;
  ok: boolean;
};

export type DashboardCommandSpec = {
  command: string;
  summary: string;
  options: readonly AutomationCommandOptionSpec[];
  examples?: readonly string[];
};

export type DashboardAutocompleteMode = "completion" | "history";

export type DashboardAutocompleteSuggestion = {
  id: string;
  kind: "argument" | "command" | "history";
  label: string;
  description: string;
  detail?: string;
  replacement: string;
  replacementStart: number;
  replacementEnd: number;
};

export type DashboardArgumentHint = AutomationCommandOptionSpec & {
  used: boolean;
};

type DashboardTerminalSnapshot = {
  cwd: string;
  entries: DashboardTerminalEntry[];
  commands: string[];
};

type UseDashboardTerminalOptions = {
  organizationId?: string | null;
  organizationName?: string | null;
  result?: DashboardCommandResult;
  disabled?: boolean;
  commandSpecs?: readonly DashboardCommandSpec[];
};

type Token = {
  value: string;
  start: number;
  end: number;
};

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trimHistory = <T>(items: T[]) => items.slice(-MAX_HISTORY);

const getStorageKey = (organizationId?: string | null) =>
  `${DASHBOARD_TERMINAL_STORAGE_KEY}:${organizationId ?? "none"}`;

const firstLine = (value: string) => value.trim().split("\n")[0]?.trim() ?? "";

const optionLabel = (option: AutomationCommandOptionSpec) => {
  const value = option.valueRequired ? ` <${option.valueName ?? "value"}>` : "";
  return `--${option.name}${value}`;
};

const uniqueNewestCommands = (commands: readonly string[]) => {
  const seen = new Set<string>();
  const newestFirst: string[] = [];

  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]?.trim();
    if (!command || seen.has(command)) {
      continue;
    }
    seen.add(command);
    newestFirst.push(command);
  }

  return newestFirst;
};

const tokenizeCommandLine = (commandLine: string): Token[] =>
  [...commandLine.matchAll(/\S+/g)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

const currentTokenAt = (commandLine: string, cursorPosition: number): Token => {
  const left = commandLine.slice(0, cursorPosition);
  const match = /(?:^|\s)(\S*)$/.exec(left);
  const value = match?.[1] ?? "";

  return {
    value,
    start: cursorPosition - value.length,
    end: cursorPosition,
  };
};

const findCommandSpec = (
  commandLine: string,
  commandSpecs: readonly DashboardCommandSpec[],
): DashboardCommandSpec | undefined => {
  const commandName = tokenizeCommandLine(commandLine)[0]?.value;
  return commandName ? commandSpecs.find((spec) => spec.command === commandName) : undefined;
};

const usedOptionNames = (tokens: readonly Token[], ignoredToken?: Token) => {
  const ignoredStart = ignoredToken?.start ?? -1;
  const ignoredEnd = ignoredToken?.end ?? -1;
  const used = new Set<string>();

  for (const token of tokens.slice(1)) {
    if (token.start === ignoredStart && token.end === ignoredEnd) {
      continue;
    }

    const match = /^--([^=\s]+)/.exec(token.value);
    if (match?.[1]) {
      used.add(match[1]);
    }
  }

  return used;
};

const formatSuggestionDescription = (option: AutomationCommandOptionSpec) => {
  const requirement = option.required ? "Required" : "Optional";
  const value = option.valueRequired ? ` · value: ${option.valueName ?? "value"}` : "";
  return `${requirement}${value}`;
};

export const shortenDashboardCwd = (cwd: string, maxLength = 40) => {
  if (cwd.length <= maxLength) {
    return cwd;
  }

  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return `…${cwd.slice(-(maxLength - 1))}`;
  }

  for (
    let visiblePartCount = Math.min(parts.length, 4);
    visiblePartCount >= 1;
    visiblePartCount -= 1
  ) {
    const shortened = `/…/${parts.slice(-visiblePartCount).join("/")}`;
    if (shortened.length <= maxLength || visiblePartCount === 1) {
      return shortened;
    }
  }

  return cwd;
};

export const createWelcomeEntry = (organizationName?: string | null): DashboardTerminalEntry => ({
  id: `welcome-${Date.now()}`,
  command: "",
  cwd: DEFAULT_CWD,
  ok: true,
  exitCode: 0,
  output: `Backoffice terminal connected to Pi bash environment.
Organization: ${organizationName ?? "no active organisation"}
Type a command and press Enter.`,
  durationMs: 0,
  timestamp: new Date().toISOString(),
});

const createSnapshot = (organizationName?: string | null): DashboardTerminalSnapshot => ({
  cwd: DEFAULT_CWD,
  entries: [createWelcomeEntry(organizationName)],
  commands: [],
});

const readSnapshot = (
  organizationId?: string | null,
  organizationName?: string | null,
): DashboardTerminalSnapshot => {
  if (typeof window === "undefined") {
    return createSnapshot(organizationName);
  }

  const raw = window.localStorage.getItem(getStorageKey(organizationId));
  return raw ? (JSON.parse(raw) as DashboardTerminalSnapshot) : createSnapshot(organizationName);
};

const writeSnapshot = (
  organizationId: string | null | undefined,
  snapshot: DashboardTerminalSnapshot,
) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getStorageKey(organizationId), JSON.stringify(snapshot));
};

const createEntry = (result: DashboardCommandResult): DashboardTerminalEntry => ({
  id: `${Date.now()}-${Math.random()}`,
  command: result.command,
  cwd: result.cwd,
  ok: result.ok,
  exitCode: result.exitCode,
  output: result.output,
  durationMs: result.durationMs,
  timestamp: new Date().toISOString(),
});

export const buildDashboardAutocomplete = ({
  commandLine,
  commandSpecs,
  cursorPosition = commandLine.length,
  history,
  mode,
}: {
  commandLine: string;
  commandSpecs: readonly DashboardCommandSpec[];
  cursorPosition?: number;
  history: readonly string[];
  mode: DashboardAutocompleteMode;
}): DashboardAutocompleteSuggestion[] => {
  const trimmedQuery = commandLine.trim().toLowerCase();
  const historyCommands = uniqueNewestCommands(history);

  if (mode === "history") {
    return historyCommands
      .filter(
        (historyCommand) => !trimmedQuery || historyCommand.toLowerCase().includes(trimmedQuery),
      )
      .slice(0, MAX_AUTOCOMPLETE_SUGGESTIONS)
      .map((historyCommand, index) => ({
        id: `history:${index}:${historyCommand}`,
        kind: "history",
        label: historyCommand,
        description: "Recent command",
        replacement: historyCommand,
        replacementStart: 0,
        replacementEnd: commandLine.length,
      }));
  }

  const tokens = tokenizeCommandLine(commandLine);
  const currentToken = currentTokenAt(commandLine, cursorPosition);
  const commandToken = tokens[0];
  const isCompletingCommand = !commandToken || cursorPosition <= commandToken.end;

  if (isCompletingCommand) {
    const query = currentToken.value.toLowerCase();
    const commandSuggestions: DashboardAutocompleteSuggestion[] = commandSpecs
      .filter((spec) => spec.command.toLowerCase().startsWith(query))
      .slice(0, MAX_AUTOCOMPLETE_SUGGESTIONS)
      .map((spec) => ({
        id: `command:${spec.command}`,
        kind: "command",
        label: spec.command,
        description: firstLine(spec.summary),
        detail: spec.options.length
          ? `${spec.options.length} argument${spec.options.length === 1 ? "" : "s"}`
          : "No arguments",
        replacement: `${spec.command} `,
        replacementStart: currentToken.start,
        replacementEnd: currentToken.end,
      }));

    if (commandSuggestions.length) {
      return commandSuggestions;
    }
  }

  const commandSpec = commandToken
    ? commandSpecs.find((spec) => spec.command === commandToken.value)
    : undefined;
  if (!commandSpec) {
    const prefix = commandLine.slice(0, cursorPosition).toLowerCase();
    return historyCommands
      .filter((historyCommand) => historyCommand.toLowerCase().startsWith(prefix))
      .slice(0, MAX_AUTOCOMPLETE_SUGGESTIONS)
      .map((historyCommand, index) => ({
        id: `history-prefix:${index}:${historyCommand}`,
        kind: "history",
        label: historyCommand,
        description: "Recent command",
        replacement: historyCommand,
        replacementStart: 0,
        replacementEnd: commandLine.length,
      }));
  }

  if (currentToken.value && !currentToken.value.startsWith("--")) {
    return [];
  }

  const usedOptions = usedOptionNames(tokens, currentToken);
  const optionQuery = currentToken.value.replace(/^--/, "").toLowerCase();

  return commandSpec.options
    .filter((option) => !usedOptions.has(option.name))
    .filter((option) => option.name.toLowerCase().startsWith(optionQuery))
    .sort((left, right) => Number(Boolean(right.required)) - Number(Boolean(left.required)))
    .slice(0, MAX_AUTOCOMPLETE_SUGGESTIONS)
    .map((option) => ({
      id: `argument:${commandSpec.command}:${option.name}`,
      kind: "argument",
      label: optionLabel(option),
      description: option.description,
      detail: formatSuggestionDescription(option),
      replacement: `--${option.name} `,
      replacementStart: currentToken.start,
      replacementEnd: currentToken.end,
    }));
};

export const getDashboardArgumentHints = ({
  commandLine,
  commandSpecs,
}: {
  commandLine: string;
  commandSpecs: readonly DashboardCommandSpec[];
}): DashboardArgumentHint[] => {
  const commandSpec = findCommandSpec(commandLine, commandSpecs);
  if (!commandSpec) {
    return [];
  }

  const usedOptions = usedOptionNames(tokenizeCommandLine(commandLine));

  return commandSpec.options
    .map((option) => ({
      ...option,
      used: usedOptions.has(option.name),
    }))
    .sort((left, right) => Number(Boolean(right.required)) - Number(Boolean(left.required)));
};

export const applyDashboardAutocompleteSuggestion = (
  commandLine: string,
  suggestion: DashboardAutocompleteSuggestion,
) => {
  const nextCommandLine = `${commandLine.slice(0, suggestion.replacementStart)}${suggestion.replacement}${commandLine.slice(suggestion.replacementEnd)}`;
  return nextCommandLine.replace(/\s+$/, " ");
};

export const extractNextCwd = (
  stderr: string | undefined,
  fallbackCwd: string,
): { stderr: string | undefined; nextCwd: string } => {
  const normalizedStderr = stderr ?? "";
  const markerPattern = new RegExp(
    `(?:\\n|^)${escapeForRegExp(DASHBOARD_CWD_MARKER)}([^\\n]*)\\n?$`,
  );
  const match = markerPattern.exec(normalizedStderr);

  if (!match) {
    return {
      stderr,
      nextCwd: fallbackCwd,
    };
  }

  const nextCwd = match[1]?.trim() || fallbackCwd;
  const cleanedStderr = normalizedStderr.slice(0, match.index) || undefined;

  return {
    stderr: cleanedStderr,
    nextCwd,
  };
};

export const wrapDashboardCommand = (command: string) => `${command}
__fragno_dashboard_exit=$?
printf '\\n%s%s\\n' '${DASHBOARD_CWD_MARKER}' "$PWD" >&2
exit "$__fragno_dashboard_exit"`;

export const useDashboardTerminal = ({
  organizationId,
  organizationName,
  result,
  disabled = false,
  commandSpecs = [],
}: UseDashboardTerminalOptions) => {
  const [snapshot, setSnapshot] = useState(() => readSnapshot(organizationId, organizationName));
  const [command, setCommand] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState("");
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [autocompleteMode, setAutocompleteMode] = useState<DashboardAutocompleteMode>("completion");
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [activeAutocompleteIndex, setActiveAutocompleteIndex] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const autocompleteSuggestions = useMemo(
    () =>
      buildDashboardAutocomplete({
        commandLine: command,
        commandSpecs,
        history: snapshot.commands,
        mode: autocompleteMode,
      }),
    [autocompleteMode, command, commandSpecs, snapshot.commands],
  );

  const argumentHints = useMemo(
    () => getDashboardArgumentHints({ commandLine: command, commandSpecs }),
    [command, commandSpecs],
  );

  const queueInputSelection = () => {
    setSelectionVersion((current) => current + 1);
  };

  const closeAutocomplete = () => {
    setAutocompleteOpen(false);
    setActiveAutocompleteIndex(0);
  };

  const openAutocomplete = (mode: DashboardAutocompleteMode) => {
    setAutocompleteMode(mode);
    setAutocompleteOpen(true);
    setActiveAutocompleteIndex(0);
  };

  const applyAutocompleteSuggestion = (suggestion: DashboardAutocompleteSuggestion) => {
    setCommand((currentCommand) =>
      applyDashboardAutocompleteSuggestion(currentCommand, suggestion),
    );
    setHistoryIndex(-1);
    setHistoryDraft("");
    closeAutocomplete();
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const nextPosition = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(nextPosition, nextPosition);
    });
  };

  useEffect(() => {
    writeSnapshot(organizationId, snapshot);
  }, [organizationId, snapshot]);

  useEffect(() => {
    if (disabled || selectionVersion === 0) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [disabled, selectionVersion]);

  useEffect(() => {
    if (!result) {
      return;
    }

    const trimmedCommand = result.command.trim();

    setSnapshot((current) => ({
      cwd: result.nextCwd,
      entries: trimHistory([...current.entries, createEntry(result)]),
      commands: trimmedCommand
        ? trimHistory([...current.commands, trimmedCommand])
        : current.commands,
    }));
    setCommand("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    closeAutocomplete();
    queueInputSelection();
  }, [result]);

  useEffect(() => {
    const node = terminalRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [snapshot.entries]);

  useEffect(() => {
    queueInputSelection();
  }, []);

  useEffect(() => {
    if (autocompleteOpen && autocompleteSuggestions.length === 0) {
      setAutocompleteOpen(false);
    }
    if (activeAutocompleteIndex >= autocompleteSuggestions.length) {
      setActiveAutocompleteIndex(Math.max(autocompleteSuggestions.length - 1, 0));
    }
  }, [activeAutocompleteIndex, autocompleteOpen, autocompleteSuggestions.length]);

  const clear = () => {
    setSnapshot(createSnapshot(organizationName));
    setCommand("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    closeAutocomplete();
    queueInputSelection();
  };

  const onCommandChange = (nextValue: string) => {
    setCommand(nextValue);

    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      setHistoryDraft(nextValue);
    }

    if (autocompleteOpen) {
      setActiveAutocompleteIndex(0);
    }

    if (!disabled && nextValue.endsWith(".")) {
      openAutocomplete("completion");
    }
  };

  const onCommandKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (autocompleteOpen && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setActiveAutocompleteIndex((currentIndex) => {
        if (autocompleteSuggestions.length === 0) {
          return 0;
        }
        const delta = event.key === "ArrowUp" ? -1 : 1;
        return (
          (currentIndex + delta + autocompleteSuggestions.length) % autocompleteSuggestions.length
        );
      });
      return;
    }

    if (autocompleteOpen && (event.key === "Enter" || event.key === "Tab")) {
      const suggestion = autocompleteSuggestions[activeAutocompleteIndex];
      if (suggestion) {
        event.preventDefault();
        applyAutocompleteSuggestion(suggestion);
      }
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      if (!disabled && snapshot.commands.length > 0) {
        openAutocomplete("history");
      }
      return;
    }

    if (event.key === "Tab") {
      if (!disabled) {
        event.preventDefault();
        openAutocomplete("completion");
      }
      return;
    }

    if (event.ctrlKey && event.key === "l") {
      event.preventDefault();
      clear();
      return;
    }

    if (event.ctrlKey && event.key === "j") {
      event.preventDefault();
      inputRef.current?.form?.requestSubmit();
      return;
    }

    if (disabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || snapshot.commands.length === 0) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      setHistoryIndex((currentIndex) => {
        const nextIndex =
          currentIndex === -1 ? snapshot.commands.length - 1 : Math.max(currentIndex - 1, 0);

        if (currentIndex === -1) {
          setHistoryDraft(command);
        }

        setCommand(snapshot.commands[nextIndex] ?? "");
        closeAutocomplete();
        return nextIndex;
      });
      return;
    }

    setHistoryIndex((currentIndex) => {
      if (currentIndex === -1) {
        return -1;
      }

      if (currentIndex >= snapshot.commands.length - 1) {
        setCommand(historyDraft);
        closeAutocomplete();
        return -1;
      }

      const nextIndex = currentIndex + 1;
      setCommand(snapshot.commands[nextIndex] ?? "");
      closeAutocomplete();
      return nextIndex;
    });
  };

  return {
    activeAutocompleteIndex,
    argumentHints,
    autocompleteMode,
    autocompleteOpen,
    autocompleteSuggestions,
    command,
    currentCwd: snapshot.cwd,
    inputRef,
    onAutocompleteSuggestionMouseDown: applyAutocompleteSuggestion,
    onCommandChange,
    onCommandKeyDown,
    clear,
    terminalHistory: snapshot.entries,
    terminalRef,
  };
};
