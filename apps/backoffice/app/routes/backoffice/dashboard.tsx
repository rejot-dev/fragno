import { Link, redirect, useOutletContext } from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { BackofficePageHeader } from "@/components/backoffice";
import { createOrgFileSystem } from "@/files";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { createInteractiveBashHost } from "@/fragno/bash-runtime/bash-host";
import { createPiBashCommandContext } from "@/fragno/pi/pi";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

import type { Route } from "./+types/dashboard";
import {
  type DashboardCommandResult,
  DASHBOARD_COMMAND_TIMEOUT_MS,
  DEFAULT_CWD,
  extractNextCwd,
  wrapDashboardCommand,
} from "./dashboard-terminal";
import { DashboardTerminalPanel } from "./dashboard-terminal-panel";

type Stat = {
  label: string;
  value: string;
  description: string;
};

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
  const cwd = cwdInput || DEFAULT_CWD;
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
    const env = context.get(CloudflareContext).env;
    const fileSystem = await createOrgFileSystem({ orgId: activeOrg.id, env });
    const piContext = createPiBashCommandContext({ env, orgId: activeOrg.id });
    const { bash } = createInteractiveBashHost({
      fs: fileSystem,
      env,
      orgId: activeOrg.id,
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

      return {
        intent: "run-command",
        ok: exitCode === 0,
        command,
        cwd,
        nextCwd,
        output,
        exitCode,
        durationMs,
      } satisfies DashboardCommandResult;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);

      return {
        intent: "run-command",
        ok: false,
        command,
        cwd,
        nextCwd: cwd,
        output: toErrorMessage(error),
        exitCode: error instanceof DashboardCommandTimeoutError ? 124 : 1,
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
        <DashboardTerminalPanel
          key={activeOrganization?.id ?? "none"}
          organizationId={activeOrganization?.id}
          organizationName={activeOrganization?.name}
        />

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
              <li>• telegram.file.get / telegram.file.download</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
