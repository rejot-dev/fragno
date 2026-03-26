import { useFetcher } from "react-router";

import {
  type DashboardCommandResult,
  shortenDashboardCwd,
  useDashboardTerminal,
} from "./dashboard-terminal";

type DashboardTerminalPanelProps = {
  organizationId?: string | null;
  organizationName?: string | null;
};

export function DashboardTerminalPanel({
  organizationId,
  organizationName,
}: DashboardTerminalPanelProps) {
  const fetcher = useFetcher<DashboardCommandResult>();
  const isSubmitting = fetcher.state !== "idle";
  const terminal = useDashboardTerminal({
    organizationId,
    organizationName,
    result: fetcher.data,
    disabled: isSubmitting,
  });

  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
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
        <p className="text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          ^J run · ^L clear · ↑↓ history
        </p>
      </div>

      <div
        ref={terminal.terminalRef}
        className="backoffice-scroll mt-4 max-h-[28rem] overflow-auto rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-xs leading-6 text-[var(--bo-fg)]"
      >
        {terminal.terminalHistory.map((entry) => (
          <div key={entry.id} className="mb-4 last:mb-0">
            <p className="text-[var(--bo-muted-2)]">
              [{new Date(entry.timestamp).toLocaleTimeString()}]
            </p>
            <p>
              <span className="text-[var(--bo-accent-fg)]">{entry.cwd}</span>
              <span className="text-[var(--bo-muted)]"> $ </span>
              <span className="text-[var(--bo-fg)]">{entry.command || "(system)"}</span>
            </p>
            <pre
              className={`whitespace-pre-wrap ${entry.ok ? "text-[var(--bo-fg)]" : "text-red-400"}`}
            >
              {entry.output}
            </pre>
            <p className="mt-1 text-[10px] text-[var(--bo-muted-2)] uppercase">
              exit {entry.exitCode} · {entry.durationMs}ms
            </p>
          </div>
        ))}
      </div>

      <fetcher.Form method="post" className="mt-4 flex gap-2">
        <input type="hidden" name="cwd" value={terminal.currentCwd} />
        <div className="flex min-w-0 flex-1 items-stretch border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
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
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-[var(--bo-fg)]"
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
      </fetcher.Form>
    </div>
  );
}
