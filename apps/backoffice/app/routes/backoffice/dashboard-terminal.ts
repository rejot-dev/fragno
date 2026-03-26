import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const DASHBOARD_CWD_MARKER = "__FRAGNO_BACKOFFICE_CWD__";
const DASHBOARD_TERMINAL_STORAGE_KEY = "backoffice.dashboard.terminal";
const MAX_HISTORY = 80;

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
};

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trimHistory = <T>(items: T[]) => items.slice(-MAX_HISTORY);

const getStorageKey = (organizationId?: string | null) =>
  `${DASHBOARD_TERMINAL_STORAGE_KEY}:${organizationId ?? "none"}`;

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
}: UseDashboardTerminalOptions) => {
  const [snapshot, setSnapshot] = useState(() => readSnapshot(organizationId, organizationName));
  const [command, setCommand] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState("");
  const [selectionVersion, setSelectionVersion] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const queueInputSelection = () => {
    setSelectionVersion((current) => current + 1);
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

  const clear = () => {
    setSnapshot(createSnapshot(organizationName));
    setCommand("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    queueInputSelection();
  };

  const onCommandChange = (nextValue: string) => {
    setCommand(nextValue);

    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      setHistoryDraft(nextValue);
    }
  };

  const onCommandKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
        return -1;
      }

      const nextIndex = currentIndex + 1;
      setCommand(snapshot.commands[nextIndex] ?? "");
      return nextIndex;
    });
  };

  return {
    command,
    currentCwd: snapshot.cwd,
    inputRef,
    onCommandChange,
    onCommandKeyDown,
    clear,
    terminalHistory: snapshot.entries,
    terminalRef,
  };
};
