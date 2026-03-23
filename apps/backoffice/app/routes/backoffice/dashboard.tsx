import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, redirect, useFetcher, useOutletContext } from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { BackofficePageHeader } from "@/components/backoffice";
import { createMasterFileSystem } from "@/files";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { createBashHost } from "@/fragno/bash-runtime/bash-host";
import { createPiBashCommandContext } from "@/fragno/pi/pi";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { fetchUploadConfig } from "@/routes/backoffice/connections/upload/data";

import type { Route } from "./+types/dashboard";
import { extractNextCwd, wrapDashboardCommand } from "./dashboard-terminal";

type Stat = {
  label: string;
  value: string;
  description: string;
};

type TerminalEntry = {
  id: string;
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  timestamp: string;
};

type DashboardCommandResult = {
  intent: "run-command";
  command: string;
  cwd: string;
  nextCwd: string;
  output: string;
  exitCode: number;
  durationMs: number;
  ok: boolean;
};

const DEFAULT_CWD = "/";
const DASHBOARD_COMMAND_TIMEOUT_MS = 15_000;

class DashboardCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms.`);
    this.name = "DashboardCommandTimeoutError";
  }
}

const formatOutput = (stdout: string | undefined, stderr: string | undefined): string => {
  const normalizedStdout = stdout?.trimEnd() ?? "";
  const normalizedStderr = stderr?.trimEnd() ?? "";
  const combined = [normalizedStdout, normalizedStderr].filter(Boolean).join("\n");
  return combined || "(no output)";
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "Command failed.";
};

const createWelcomeEntry = (organizationName?: string | null): TerminalEntry => ({
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

function StatCard({ label, value, description }: Stat) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-[var(--bo-fg)]">{value}</p>
      <p className="mt-2 text-xs text-[var(--bo-muted)]">{description}</p>
    </div>
  );
}

export function meta() {
  return [
    { title: "Backoffice Dashboard" },
    { name: "description", content: "Fragno backoffice overview dashboard." },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect("/backoffice/login");
  }

  const formData = await request.formData();
  const command = String(formData.get("command") ?? "").trim();
  const cwdInput = String(formData.get("cwd") ?? "").trim();
  const cwd = cwdInput.length > 0 ? cwdInput : DEFAULT_CWD;
  const activeOrg = me.activeOrganization?.organization;

  if (!command) {
    return {
      intent: "run-command",
      ok: false,
      command: "",
      cwd,
      nextCwd: cwd,
      output: "No command provided.",
      exitCode: 1,
      durationMs: 0,
    } satisfies DashboardCommandResult;
  }

  if (!activeOrg) {
    return {
      intent: "run-command",
      ok: false,
      command,
      cwd,
      nextCwd: cwd,
      output: "No active organization selected. Choose an organization to use the PI filesystem.",
      exitCode: 1,
      durationMs: 0,
    } satisfies DashboardCommandResult;
  }

  try {
    const { configState, configError } = await fetchUploadConfig(context, activeOrg.id);
    if (configError) {
      return {
        intent: "run-command",
        ok: false,
        command,
        cwd,
        nextCwd: cwd,
        output: `Unable to initialize filesystem: ${configError}`,
        exitCode: 1,
        durationMs: 0,
      } satisfies DashboardCommandResult;
    }

    const fileSystem = await createMasterFileSystem({
      orgId: activeOrg.id,
      origin: new URL(request.url).origin,
      backend: "pi",
      uploadConfig: configState,
      request,
      routerContext: context,
    });

    const piContext = createPiBashCommandContext({
      env: context.get(CloudflareContext).env,
      orgId: activeOrg.id,
    });

    const { bash } = createBashHost({
      fs: fileSystem,
      context: piContext,
    });

    const startedAt = performance.now();
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        bash.exec(wrapDashboardCommand(command), {
          cwd,
          signal: abortController.signal,
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort();
            reject(new DashboardCommandTimeoutError(DASHBOARD_COMMAND_TIMEOUT_MS));
          }, DASHBOARD_COMMAND_TIMEOUT_MS);
        }),
      ]);
      const durationMs = Math.round(performance.now() - startedAt);
      const { stderr, nextCwd } = extractNextCwd(result.stderr, cwd);

      const output = formatOutput(result.stdout, stderr);
      const exitCode = result.exitCode ?? 0;
      const commandSucceeded = exitCode === 0;

      return {
        intent: "run-command",
        ok: commandSucceeded,
        command,
        cwd,
        nextCwd,
        output,
        exitCode,
        durationMs,
      } satisfies DashboardCommandResult;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const exitCode = error instanceof DashboardCommandTimeoutError ? 124 : 1;

      return {
        intent: "run-command",
        ok: false,
        command,
        cwd,
        nextCwd: cwd,
        output: toErrorMessage(error),
        exitCode,
        durationMs,
      } satisfies DashboardCommandResult;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  } catch (error) {
    return {
      intent: "run-command",
      ok: false,
      command,
      cwd,
      nextCwd: cwd,
      output: toErrorMessage(error),
      exitCode: 1,
      durationMs: 0,
    } satisfies DashboardCommandResult;
  }
}

export default function BackofficeDashboard() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const activeOrganization = me?.activeOrganization?.organization ?? null;

  const stats: Stat[] = [
    {
      label: "Organizations",
      value: String(me.organizations.length),
      description: me.organizations.length
        ? "Organisations available for this account."
        : "No organisations are currently available.",
    },
    {
      label: "Active organisation",
      value: activeOrganization?.name ?? "Not selected",
      description: activeOrganization
        ? `Current workspace: ${activeOrganization.slug}`
        : "Choose an organisation to scope org-level workflows and data.",
    },
    {
      label: "Signed in as",
      value: me.user.role,
      description: "Role for the active Fragno session.",
    },
  ];

  const fetcher = useFetcher<typeof action>();
  const commandSubmitState = fetcher.state;
  const isSubmitting = commandSubmitState !== "idle";
  const latestAction = fetcher.data;

  const [command, setCommand] = useState("");
  const [currentCwd, setCurrentCwd] = useState(DEFAULT_CWD);
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>(() => [
    createWelcomeEntry(activeOrganization?.name),
  ]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState("");
  const terminalRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!latestAction || latestAction.intent !== "run-command") {
      return;
    }

    const commandForHistory = latestAction.command?.trim();
    if (commandForHistory) {
      setCommandHistory((previous) => {
        const next = [...previous, commandForHistory];
        return next.length > 80 ? next.slice(next.length - 80) : next;
      });
    }

    setTerminalHistory((previous) => {
      const next = [
        ...previous,
        {
          id: `${Date.now()}-${Math.random()}`,
          command: latestAction.command,
          cwd: latestAction.cwd,
          ok: latestAction.ok,
          exitCode: latestAction.exitCode,
          output: latestAction.output,
          durationMs: latestAction.durationMs,
          timestamp: new Date().toISOString(),
        } satisfies TerminalEntry,
      ];
      return next.length > 80 ? next.slice(next.length - 80) : next;
    });

    setCommand("");
    setCurrentCwd(latestAction.nextCwd);
    setHistoryIndex(-1);
    setHistoryDraft("");
  }, [latestAction]);

  useEffect(() => {
    const node = terminalRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [terminalHistory]);

  const handleCommandKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isSubmitting) {
      return;
    }

    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (commandHistory.length === 0) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      setHistoryIndex((previousIndex) => {
        const nextIndex =
          previousIndex === -1 ? commandHistory.length - 1 : Math.max(previousIndex - 1, 0);

        setHistoryDraft((currentDraft) => {
          if (previousIndex === -1) {
            return command;
          }
          return currentDraft;
        });

        setCommand(commandHistory[nextIndex] ?? "");
        return nextIndex;
      });
      return;
    }

    setHistoryIndex((previousIndex) => {
      if (previousIndex === -1) {
        return -1;
      }

      if (previousIndex >= commandHistory.length - 1) {
        setCommand(historyDraft);
        return -1;
      }

      const nextIndex = previousIndex + 1;
      setCommand(commandHistory[nextIndex] ?? "");
      return nextIndex;
    });
  };

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Overview" }]}
        eyebrow="Control"
        title="Backoffice overview"
        description="Run commands in a terminal connected to the same Pi bash runtime used by fragment sessions."
        actions={
          <>
            <Link
              to="/backoffice/settings"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              Workspace settings
            </Link>
            <Link
              to="/backoffice/organisations"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Open organisations
            </Link>
          </>
        }
      />

      <section className="grid gap-3 lg:grid-cols-3">
        {stats.map((stat) => (
          <StatCard key={stat.label} {...stat} />
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="space-y-2">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Pi terminal
            </p>
            <p className="text-sm text-[var(--bo-muted)]">
              Command output is executed against the backoffice Pi-backed filesystem (/system,
              /workspace).
            </p>
          </div>

          <div
            ref={terminalRef}
            className="backoffice-scroll mt-4 max-h-[28rem] overflow-auto rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-xs leading-6 text-[var(--bo-fg)]"
          >
            {terminalHistory.map((entry) => (
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
                  className={`whitespace-pre-wrap ${
                    entry.ok ? "text-[var(--bo-fg)]" : "text-red-400"
                  }`}
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
            <input type="hidden" name="cwd" value={currentCwd} />
            <input
              name="command"
              value={command}
              onChange={(event) => {
                const nextValue = event.target.value;
                setCommand(nextValue);
                if (historyIndex !== -1) {
                  setHistoryIndex(-1);
                  setHistoryDraft(nextValue);
                }
              }}
              onKeyDown={handleCommandKeyDown}
              ref={commandInputRef}
              placeholder="Run a bash command (e.g. ls /workspace, pwd, find /system)"
              className="flex-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSubmitting}
            />
            <button
              type="submit"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Running" : "Run"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCurrentCwd(DEFAULT_CWD);
                setTerminalHistory([createWelcomeEntry(activeOrganization?.name)]);
              }}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase"
              disabled={isSubmitting}
            >
              Clear
            </button>
          </fetcher.Form>
        </div>

        <div className="space-y-4">
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Connected environment
            </p>
            <p className="mt-2 text-sm text-[var(--bo-muted)]">
              Runs inside the same filesystem and runtime used by Pi sessions: starter workspace,
              optional Upload mount, and the PI custom command layer.
            </p>
          </div>

          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Supported quick checks
            </p>
            <ul className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
              <li>• ls, cat, find, pwd</li>
              <li>• pi.session.get / pi.session.create / pi.session.turn</li>
              <li>• automations.identity.* and otp.identity.* commands</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
