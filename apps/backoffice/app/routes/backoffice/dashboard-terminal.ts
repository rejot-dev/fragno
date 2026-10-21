import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";

const DASHBOARD_CWD_MARKER = "__FRAGNO_BACKOFFICE_CWD__";
const DASHBOARD_TERMINAL_STORAGE_KEY = "backoffice.dashboard.terminal";
const DASHBOARD_COMMAND_HISTORY_STORAGE_KEY = "backoffice.dashboard.terminal.commands";
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

type DashboardAutocompleteMode = "completion" | "history";

export type DashboardAutocompleteSuggestion = {
  id: string;
  kind: "argument" | "command" | "history" | "path" | "scope";
  label: string;
  description: string;
  detail?: string;
  replacement: string;
  replacementStart: number;
  replacementEnd: number;
};

/** A scope's own session: what it printed and where it is. Commands are recalled across scopes. */
type DashboardTerminalSnapshot = {
  cwd: string;
  entries: DashboardTerminalEntry[];
};

/** A scope the terminal can run commands in, named as `use` accepts it. */
export type DashboardTerminalScope = {
  id: string;
  name: string;
  label: string;
  actionPath: string;
};

type UseDashboardTerminalOptions = {
  scopeId?: string | null;
  scopeName?: string | null;
  result?: DashboardCommandResult;
  pathAutocompleteResult?: DashboardPathAutocompleteResult;
  requestPathAutocomplete?: (request: DashboardPathAutocompleteRequest) => void;
  disabled?: boolean;
  commandSpecs?: readonly DashboardCommandSpec[];
  scopes: readonly DashboardTerminalScope[];
};

type Token = {
  value: string;
  start: number;
  end: number;
};

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trimHistory = <T>(items: T[]) => items.slice(-MAX_HISTORY);

const getStorageKey = (scopeId?: string | null) =>
  `${DASHBOARD_TERMINAL_STORAGE_KEY}:${scopeId ?? "none"}`;

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

/**
 * A `\` before a newline only continues the command, so tokens read it as blanks. Same length, so
 * token offsets still index the typed command line.
 */
const withoutLineContinuations = (commandLine: string) => commandLine.replace(/\\\n/g, "  ");

const tokenizeCommandLine = (commandLine: string): Token[] =>
  [...withoutLineContinuations(commandLine).matchAll(/\S+/g)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

const currentTokenAt = (commandLine: string, cursorPosition: number): Token => {
  const left = withoutLineContinuations(commandLine).slice(0, cursorPosition);
  const match = /(?:^|\s)(\S*)$/.exec(left);
  const value = match?.[1] ?? "";

  return {
    value,
    start: cursorPosition - value.length,
    end: cursorPosition,
  };
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
    result?.ok &&
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

const createWelcomeEntry = (
  scopeName?: string | null,
  timestamp = new Date().toISOString(),
): DashboardTerminalEntry => ({
  id: `welcome-${timestamp}`,
  command: "",
  cwd: DEFAULT_CWD,
  ok: true,
  exitCode: 0,
  output: `Backoffice terminal connected to the selected runtime-tool bash scope.
Scope: ${scopeName ?? "unscoped"}
Type a command and press Enter. End a line with \\ to continue it; run 'use' to switch scope.`,
  durationMs: 0,
  timestamp,
});

const createSnapshot = (
  scopeName?: string | null,
  timestamp?: string,
): DashboardTerminalSnapshot => ({
  cwd: DEFAULT_CWD,
  entries: [createWelcomeEntry(scopeName, timestamp)],
});

const createHydrationSafeSnapshot = (scopeName?: string | null) =>
  createSnapshot(scopeName, HYDRATION_SAFE_WELCOME_TIMESTAMP);

const readSnapshot = (
  scopeId?: string | null,
  scopeName?: string | null,
): DashboardTerminalSnapshot => {
  if (typeof window === "undefined") {
    return createHydrationSafeSnapshot(scopeName);
  }

  const raw = window.localStorage.getItem(getStorageKey(scopeId));
  return raw ? (JSON.parse(raw) as DashboardTerminalSnapshot) : createSnapshot(scopeName);
};

const writeSnapshot = (scopeId: string | null | undefined, snapshot: DashboardTerminalSnapshot) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getStorageKey(scopeId), JSON.stringify(snapshot));
};

/** Like a shell's history file, one list of commands serves every scope's session. */
const readCommandHistory = (): string[] => {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(DASHBOARD_COMMAND_HISTORY_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
};

const writeCommandHistory = (commands: readonly string[]) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(DASHBOARD_COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(commands));
};

const withResult = (
  snapshot: DashboardTerminalSnapshot,
  result: DashboardCommandResult,
): DashboardTerminalSnapshot => ({
  cwd: result.nextCwd,
  entries: trimHistory([...snapshot.entries, createEntry(result)]),
});

const withCommand = (commands: string[], command: string) => {
  const trimmedCommand = command.trim();
  return trimmedCommand ? trimHistory([...commands, trimmedCommand]) : commands;
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
  scopes,
}: {
  commandLine: string;
  commandSpecs: readonly DashboardCommandSpec[];
  currentCwd?: string;
  cursorPosition?: number;
  history: readonly string[];
  mode: DashboardAutocompleteMode;
  pathAutocompleteResult?: DashboardPathAutocompleteResult;
  scopes: readonly DashboardTerminalScope[];
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
    // Unlike the other suggestion kinds, command-name completion is not capped:
    // an initial Tab on an empty prompt should surface every command, mirroring
    // what `help` lists. The popup scrolls (`max-h-64 overflow-auto`) for overflow.
    const commandSuggestions: DashboardAutocompleteSuggestion[] = commandSpecs
      .filter((spec) => spec.command.toLowerCase().startsWith(query))
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

  if (commandToken?.value === DASHBOARD_USE_COMMAND_SPEC.command) {
    const query = currentToken.value.toLowerCase();
    return scopes
      .filter((scope) => scope.name.toLowerCase().startsWith(query))
      .map((scope) => ({
        id: `scope:${scope.id}`,
        kind: "scope",
        label: scope.name,
        description: scope.label,
        replacement: scope.name,
        replacementStart: currentToken.start,
        replacementEnd: currentToken.end,
      }));
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

export const DASHBOARD_USE_COMMAND_SPEC: DashboardCommandSpec = {
  command: "use",
  summary: "Switch this terminal to another scope. Without a name, lists the scopes.",
  options: [],
};

/**
 * `use` is the terminal's own builtin: it changes which scope later commands run in, so it never
 * reaches bash. A switch is left to the caller; anything else is answered in place.
 */
export const resolveDashboardUseCommand = ({
  command,
  cwd,
  scopes,
  current,
}: {
  command: string;
  cwd: string;
  scopes: readonly DashboardTerminalScope[];
  current: DashboardTerminalScope;
}):
  | { kind: "not-use" }
  | { kind: "switch"; scope: DashboardTerminalScope }
  | { kind: "reply"; result: DashboardCommandResult } => {
  const match = /^use(?:\s+(.+))?$/.exec(withoutLineContinuations(command).trim());
  if (!match) {
    return { kind: "not-use" };
  }

  const reply = (ok: boolean, output: string) => ({
    kind: "reply" as const,
    result: {
      intent: "run-command" as const,
      command,
      cwd,
      nextCwd: cwd,
      output,
      exitCode: ok ? 0 : 1,
      durationMs: 0,
      ok,
    },
  });
  const name = match[1];
  if (!name) {
    const width = Math.max(...scopes.map((scope) => scope.name.length));
    return reply(
      true,
      scopes
        .map(
          (scope) =>
            `${scope.id === current.id ? "*" : " "} ${scope.name.padEnd(width)}  ${scope.label}`,
        )
        .join("\n"),
    );
  }

  if (/\s/.test(name)) {
    return reply(false, "use: takes one scope name. Run 'use' to list scopes.");
  }
  const scope = scopes.find((candidate) => candidate.name === name);
  if (!scope) {
    return reply(false, `use: no scope named '${name}'. Run 'use' to list scopes.`);
  }
  if (scope.id === current.id) {
    return reply(true, `Already in ${scope.label}`);
  }
  return { kind: "switch", scope };
};

/**
 * Records a switch with `use` at the end of the destination's session, which is shown next, so
 * the scrollback says how it got there.
 */
export const recordDashboardTerminalArrival = ({
  scope,
  from,
  command,
}: {
  scope: DashboardTerminalScope;
  from: DashboardTerminalScope;
  command: string;
}) => {
  const snapshot = readSnapshot(scope.actionPath, scope.label);
  writeSnapshot(
    scope.actionPath,
    withResult(snapshot, {
      intent: "run-command",
      command,
      cwd: snapshot.cwd,
      nextCwd: snapshot.cwd,
      output: `Switched from ${from.label} to ${scope.label}`,
      exitCode: 0,
      durationMs: 0,
      ok: true,
    }),
  );
  writeCommandHistory(withCommand(readCommandHistory(), command));
};

/** An odd run of trailing backslashes escapes the newline that follows, continuing the command. */
const endsWithLineContinuation = (text: string) => /(?:^|[^\\])(?:\\\\)*\\$/.test(text);

export const useDashboardTerminal = ({
  scopeId,
  scopeName,
  result,
  pathAutocompleteResult,
  requestPathAutocomplete,
  disabled = false,
  commandSpecs = [],
  scopes,
}: UseDashboardTerminalOptions) => {
  const [snapshot, setSnapshot] = useState(() => createHydrationSafeSnapshot(scopeName));
  const [commands, setCommands] = useState<string[]>([]);
  const [snapshotHydrated, setSnapshotHydrated] = useState(false);
  const [command, setCommand] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState("");
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [autocompleteMode, setAutocompleteMode] = useState<DashboardAutocompleteMode>("completion");
  const [autocompleteRequested, setAutocompleteRequested] = useState(false);
  const [activeAutocompleteIndex, setActiveAutocompleteIndex] = useState(0);
  // Whether the user reached for the list (Tab, ^R, or the arrows) rather than it opening as they
  // typed; only then does Enter take a suggestion instead of running the command.
  const [autocompleteEngaged, setAutocompleteEngaged] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const autocompleteSuggestions = useMemo(
    () =>
      buildDashboardAutocomplete({
        commandLine: command,
        commandSpecs,
        currentCwd: snapshot.cwd,
        history: commands,
        mode: autocompleteMode,
        pathAutocompleteResult,
        scopes,
      }),
    [
      autocompleteMode,
      command,
      commandSpecs,
      pathAutocompleteResult,
      scopes,
      commands,
      snapshot.cwd,
    ],
  );
  // Shown only with something to show, so a keypress racing the close never lands on an empty list.
  const autocompleteOpen = autocompleteRequested && autocompleteSuggestions.length > 0;

  const queueInputSelection = () => {
    setSelectionVersion((current) => current + 1);
  };

  const closeAutocomplete = () => {
    setAutocompleteRequested(false);
    setActiveAutocompleteIndex(0);
    setAutocompleteEngaged(false);
  };

  const openAutocomplete = (mode: DashboardAutocompleteMode, engaged: boolean) => {
    setAutocompleteMode(mode);
    setAutocompleteRequested(true);
    setActiveAutocompleteIndex(0);
    setAutocompleteEngaged(engaged);
  };

  const placeCaret = (position: number) => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const settle = (commandResult: DashboardCommandResult) => {
    setSnapshot((current) => withResult(current, commandResult));
    setCommands((current) => withCommand(current, commandResult.command));
    setCommand("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    closeAutocomplete();
    queueInputSelection();
  };

  const applyAutocompleteSuggestion = (suggestion: DashboardAutocompleteSuggestion) => {
    setCommand((currentCommand) =>
      applyDashboardAutocompleteSuggestion(currentCommand, suggestion),
    );
    setHistoryIndex(-1);
    setHistoryDraft("");
    closeAutocomplete();
    placeCaret(applyDashboardAutocompleteSuggestion(command, suggestion).length);
  };

  useEffect(() => {
    setSnapshot(readSnapshot(scopeId, scopeName));
    setCommands(readCommandHistory());
    setSnapshotHydrated(true);
  }, [scopeId, scopeName]);

  useEffect(() => {
    if (!snapshotHydrated) {
      return;
    }

    writeSnapshot(scopeId, snapshot);
  }, [scopeId, snapshot, snapshotHydrated]);

  useEffect(() => {
    if (snapshotHydrated) {
      writeCommandHistory(commands);
    }
  }, [commands, snapshotHydrated]);

  useEffect(() => {
    if (disabled || selectionVersion === 0) {
      return undefined;
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
    if (result) {
      settle(result);
    }
  }, [result]);

  useEffect(() => {
    const node = terminalRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [snapshot.entries]);

  useEffect(() => {
    if (autocompleteRequested && autocompleteSuggestions.length === 0) {
      setAutocompleteRequested(false);
    }
    if (activeAutocompleteIndex >= autocompleteSuggestions.length) {
      setActiveAutocompleteIndex(Math.max(autocompleteSuggestions.length - 1, 0));
    }
  }, [activeAutocompleteIndex, autocompleteRequested, autocompleteSuggestions.length]);

  useEffect(() => {
    if (disabled || !autocompleteSuggestions.some((suggestion) => suggestion.kind === "path")) {
      return;
    }

    openAutocomplete("completion", false);
  }, [autocompleteSuggestions, disabled]);

  useEffect(() => {
    if (disabled || !requestPathAutocomplete) {
      return undefined;
    }

    const request = getDashboardPathAutocompleteRequest({
      commandLine: command,
      cwd: snapshot.cwd,
    });
    if (!request) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      requestPathAutocomplete(request);
    }, 120);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [command, disabled, requestPathAutocomplete, snapshot.cwd]);

  const clear = () => {
    setSnapshot(createSnapshot(scopeName));
    setCommand("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    closeAutocomplete();
    queueInputSelection();
  };

  const onCommandChange = (nextValue: string) => {
    const insertedText = nextValue.length > command.length;
    setCommand(nextValue);

    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      setHistoryDraft(nextValue);
    }

    if (autocompleteOpen) {
      setActiveAutocompleteIndex(0);
      setAutocompleteEngaged(false);
    }

    if (!disabled && insertedText && (nextValue.endsWith(".") || nextValue.endsWith(" "))) {
      openAutocomplete("completion", false);
    }
  };

  const onCommandKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isPlainEnter =
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey;
    // A line continuation wins over an open suggestion: the `\` says what Enter is for.
    if (isPlainEnter) {
      const { selectionStart, selectionEnd } = event.currentTarget;
      const before = command.slice(0, selectionStart);
      if (event.shiftKey) {
        // Shift+Enter writes the continuation the user would otherwise type.
        event.preventDefault();
        const continuation = endsWithLineContinuation(before)
          ? "\n"
          : `${before === "" || before.endsWith(" ") ? "" : " "}\\\n`;
        setCommand(`${before}${continuation}${command.slice(selectionEnd)}`);
        closeAutocomplete();
        placeCaret(before.length + continuation.length);
        return;
      }
      if (endsWithLineContinuation(before)) {
        closeAutocomplete();
        return;
      }
    }

    if (autocompleteOpen && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setAutocompleteEngaged(true);
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

    const activeSuggestion = autocompleteOpen
      ? autocompleteSuggestions[activeAutocompleteIndex]
      : undefined;
    if (
      activeSuggestion &&
      (event.key === "Tab" || (event.key === "Enter" && autocompleteEngaged))
    ) {
      event.preventDefault();
      applyAutocompleteSuggestion(activeSuggestion);
      return;
    }

    if (isPlainEnter) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      if (!disabled && commands.length > 0) {
        openAutocomplete("history", true);
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

        openAutocomplete("completion", true);
      }
      return;
    }

    if (event.ctrlKey && event.key === "l") {
      event.preventDefault();
      clear();
      return;
    }

    // Like a shell, ^C abandons the line; with text selected it stays copy, as on Windows and Linux.
    if (
      event.ctrlKey &&
      event.key === "c" &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      event.preventDefault();
      setCommand("");
      setHistoryIndex(-1);
      setHistoryDraft("");
      closeAutocomplete();
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

    if (event.metaKey || event.ctrlKey || event.altKey || commands.length === 0) {
      return;
    }

    // Within a multi-line command the arrows move between its lines; history is past either end.
    const { selectionStart, selectionEnd } = event.currentTarget;
    if (
      event.key === "ArrowUp"
        ? command.slice(0, selectionStart).includes("\n")
        : command.slice(selectionEnd).includes("\n")
    ) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      const nextIndex = historyIndex === -1 ? commands.length - 1 : Math.max(historyIndex - 1, 0);

      if (historyIndex === -1) {
        setHistoryDraft(command);
      }

      setHistoryIndex(nextIndex);
      setCommand(commands[nextIndex] ?? "");
      closeAutocomplete();
      return;
    }

    if (historyIndex === -1) {
      return;
    }

    if (historyIndex >= commands.length - 1) {
      setHistoryIndex(-1);
      setCommand(historyDraft);
      closeAutocomplete();
      return;
    }

    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setCommand(commands[nextIndex] ?? "");
    closeAutocomplete();
  };

  return {
    activeAutocompleteIndex,
    autocompleteMode,
    autocompleteOpen,
    autocompleteSuggestions,
    command,
    currentCwd: snapshot.cwd,
    inputRef,
    onAutocompleteSuggestionMouseDown: applyAutocompleteSuggestion,
    onCommandChange,
    onCommandKeyDown,
    closeAutocomplete,
    clear,
    reply: settle,
    terminalHistory: snapshot.entries,
    terminalRef,
  };
};
