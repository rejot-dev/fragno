import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";

const DASHBOARD_CWD_MARKER = "__FRAGNO_BACKOFFICE_CWD__";
const DASHBOARD_TERMINAL_STORAGE_KEY = "backoffice.dashboard.terminal";
const HYDRATION_SAFE_WELCOME_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const MAX_HISTORY = 80;
const MAX_AUTOCOMPLETE_SUGGESTIONS = 8;
const DASHBOARD_PATH_COMPLETION_COMMANDS = new Set(["cat", "cd", "find", "ls"]);

export const DEFAULT_CWD = "/";
export const DASHBOARD_COMMAND_TIMEOUT_MS = 15_000;

type DashboardTerminalEntry = {
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

export type DashboardPathAutocompleteEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type DashboardPathAutocompleteRequest = {
  intent: "autocomplete-path";
  commandLine: string;
  cwd: string;
  cursorPosition: number;
  parentPath: string;
  query: string;
  replacementStart: number;
  replacementEnd: number;
  directoriesOnly: boolean;
};

export type DashboardPathAutocompleteResult = DashboardPathAutocompleteRequest & {
  ok: boolean;
  entries: DashboardPathAutocompleteEntry[];
  error?: string;
};

export type DashboardTerminalActionResult =
  | DashboardCommandResult
  | DashboardPathAutocompleteResult;

export type DashboardCommandSpec = {
  command: string;
  summary: string;
  options: readonly AutomationCommandOptionSpec[];
  examples?: readonly string[];
};

export type DashboardAutocompleteMode = "completion" | "history";

export type DashboardAutocompleteSuggestion = {
  id: string;
  kind: "argument" | "command" | "history" | "path";
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
  pathAutocompleteResult?: DashboardPathAutocompleteResult;
  requestPathAutocomplete?: (request: DashboardPathAutocompleteRequest) => void;
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

const splitPathToken = (pathToken: string) => {
  const separatorIndex = pathToken.lastIndexOf("/");
  if (separatorIndex === -1) {
    return {
      parentPath: "",
      query: pathToken,
    };
  }

  return {
    parentPath: pathToken.slice(0, separatorIndex + 1) || "/",
    query: pathToken.slice(separatorIndex + 1),
  };
};

const joinPathCompletion = (parentPath: string, name: string, isDirectory: boolean) => {
  const prefix = parentPath && parentPath !== "/" ? parentPath.replace(/\/+$/, "/") : parentPath;
  const replacement = `${prefix}${name}`;
  return isDirectory ? `${replacement}/` : replacement;
};

const isMatchingPathAutocompleteResult = (
  request: DashboardPathAutocompleteRequest,
  result: DashboardPathAutocompleteResult | undefined,
) =>
  Boolean(
    result &&
    result.ok &&
    result.commandLine === request.commandLine &&
    result.cwd === request.cwd &&
    result.cursorPosition === request.cursorPosition &&
    result.parentPath === request.parentPath &&
    result.query === request.query &&
    result.replacementStart === request.replacementStart &&
    result.replacementEnd === request.replacementEnd &&
    result.directoriesOnly === request.directoriesOnly,
  );

export const getDashboardPathAutocompleteRequest = ({
  commandLine,
  cwd,
  cursorPosition = commandLine.length,
}: {
  commandLine: string;
  cwd: string;
  cursorPosition?: number;
}): DashboardPathAutocompleteRequest | null => {
  const tokens = tokenizeCommandLine(commandLine);
  const commandToken = tokens[0];
  if (!commandToken || cursorPosition <= commandToken.end) {
    return null;
  }

  if (!DASHBOARD_PATH_COMPLETION_COMMANDS.has(commandToken.value)) {
    return null;
  }

  const currentToken = currentTokenAt(commandLine, cursorPosition);
  if (currentToken.value.startsWith("--")) {
    return null;
  }

  const { parentPath, query } = splitPathToken(currentToken.value);

  return {
    intent: "autocomplete-path",
    commandLine,
    cwd,
    cursorPosition,
    parentPath,
    query,
    replacementStart: currentToken.start,
    replacementEnd: currentToken.end,
    directoriesOnly: commandToken.value === "cd",
  };
};

const buildDashboardPathAutocompleteSuggestions = (
  request: DashboardPathAutocompleteRequest,
  result: DashboardPathAutocompleteResult | undefined,
): DashboardAutocompleteSuggestion[] => {
  if (!result || !isMatchingPathAutocompleteResult(request, result)) {
    return [];
  }

  return result.entries.slice(0, MAX_AUTOCOMPLETE_SUGGESTIONS).map((entry) => {
    const replacement = joinPathCompletion(request.parentPath, entry.name, entry.isDirectory);
    return {
      id: `path:${entry.path}`,
      kind: "path",
      label: replacement,
      description: entry.path,
      detail: entry.isDirectory ? "Directory" : "File",
      replacement,
      replacementStart: request.replacementStart,
      replacementEnd: request.replacementEnd,
    };
  });
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

export const createWelcomeEntry = (
  organizationName?: string | null,
  timestamp = new Date().toISOString(),
): DashboardTerminalEntry => ({
  id: `welcome-${timestamp}`,
  command: "",
  cwd: DEFAULT_CWD,
  ok: true,
  exitCode: 0,
  output: `Backoffice terminal connected to Pi bash environment.
Organization: ${organizationName ?? "no active organisation"}
Type a command and press Enter.`,
  durationMs: 0,
  timestamp,
});

const createSnapshot = (
  organizationName?: string | null,
  timestamp?: string,
): DashboardTerminalSnapshot => ({
  cwd: DEFAULT_CWD,
  entries: [createWelcomeEntry(organizationName, timestamp)],
  commands: [],
});

const createHydrationSafeSnapshot = (organizationName?: string | null) =>
  createSnapshot(organizationName, HYDRATION_SAFE_WELCOME_TIMESTAMP);

const readSnapshot = (
  organizationId?: string | null,
  organizationName?: string | null,
): DashboardTerminalSnapshot => {
  if (typeof window === "undefined") {
    return createHydrationSafeSnapshot(organizationName);
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
  currentCwd = DEFAULT_CWD,
  cursorPosition = commandLine.length,
  history,
  mode,
  pathAutocompleteResult,
}: {
  commandLine: string;
  commandSpecs: readonly DashboardCommandSpec[];
  currentCwd?: string;
  cursorPosition?: number;
  history: readonly string[];
  mode: DashboardAutocompleteMode;
  pathAutocompleteResult?: DashboardPathAutocompleteResult;
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

  const pathAutocompleteRequest = getDashboardPathAutocompleteRequest({
    commandLine,
    cwd: currentCwd,
    cursorPosition,
  });
  const pathAutocompleteSuggestions = pathAutocompleteRequest
    ? buildDashboardPathAutocompleteSuggestions(pathAutocompleteRequest, pathAutocompleteResult)
    : [];
  if (pathAutocompleteSuggestions.length) {
    return pathAutocompleteSuggestions;
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
  pathAutocompleteResult,
  requestPathAutocomplete,
  disabled = false,
  commandSpecs = [],
}: UseDashboardTerminalOptions) => {
  const [snapshot, setSnapshot] = useState(() => createHydrationSafeSnapshot(organizationName));
  const [snapshotHydrated, setSnapshotHydrated] = useState(false);
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
        currentCwd: snapshot.cwd,
        history: snapshot.commands,
        mode: autocompleteMode,
        pathAutocompleteResult,
      }),
    [
      autocompleteMode,
      command,
      commandSpecs,
      pathAutocompleteResult,
      snapshot.commands,
      snapshot.cwd,
    ],
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
    setSnapshot(readSnapshot(organizationId, organizationName));
    setSnapshotHydrated(true);
  }, [organizationId, organizationName]);

  useEffect(() => {
    if (!snapshotHydrated) {
      return;
    }

    writeSnapshot(organizationId, snapshot);
  }, [organizationId, snapshot, snapshotHydrated]);

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

  useEffect(() => {
    if (disabled || !autocompleteSuggestions.some((suggestion) => suggestion.kind === "path")) {
      return;
    }

    setAutocompleteMode("completion");
    setAutocompleteOpen(true);
    setActiveAutocompleteIndex(0);
  }, [autocompleteSuggestions, disabled]);

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
        const cursorPosition = inputRef.current?.selectionStart ?? command.length;
        const pathAutocompleteRequest = getDashboardPathAutocompleteRequest({
          commandLine: command,
          cwd: snapshot.cwd,
          cursorPosition,
        });

        if (pathAutocompleteRequest && requestPathAutocomplete) {
          closeAutocomplete();
          requestPathAutocomplete(pathAutocompleteRequest);
          return;
        }

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
