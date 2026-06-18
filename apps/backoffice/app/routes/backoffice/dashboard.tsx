import { Link, redirect, useOutletContext } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BackofficePageHeader } from "@/components/backoffice";
import { createBackofficeFileSystem, type IFileSystem } from "@/files";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";
import { STANDARD_COMMAND_OPTIONS } from "@/fragno/runtime-tools/bash-cli";
import {
  createRuntimeToolReferenceContext,
  createRuntimeToolReferences,
  renderDashboardCommandGroups,
} from "@/fragno/runtime-tools/reference";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/dashboard";
import {
  type DashboardCommandResult,
  type DashboardPathAutocompleteEntry,
  type DashboardPathAutocompleteResult,
  DASHBOARD_COMMAND_TIMEOUT_MS,
  DEFAULT_CWD,
  extractNextCwd,
  getDashboardPathAutocompleteRequest,
  wrapDashboardCommand,
} from "./dashboard-terminal";
import { DashboardTerminalPanel } from "./dashboard-terminal-panel";

type Stat = {
  label: string;
  value: string;
  description: string;
};

const DASHBOARD_COMMAND_REFERENCES = createRuntimeToolReferences({
  families: runtimeToolFamilies,
  context: createRuntimeToolReferenceContext(),
});
const DASHBOARD_VISIBLE_COMMAND_REFERENCES = createRuntimeToolReferences({
  families: runtimeToolFamilies.filter((family) => !family.hidden),
  context: createRuntimeToolReferenceContext(),
});
const DASHBOARD_COMMAND_GROUPS = renderDashboardCommandGroups(DASHBOARD_VISIBLE_COMMAND_REFERENCES);
const DASHBOARD_SHELL_COMMAND_SPECS = [
  { command: "cat", summary: "Print file contents.", options: [] },
  { command: "cd", summary: "Change the terminal working directory.", options: [] },
  { command: "find", summary: "Search for files under a directory.", options: [] },
  { command: "ls", summary: "List files and directories.", options: [] },
  { command: "pwd", summary: "Print the terminal working directory.", options: [] },
] as const;
const appendStandardCommandOptions = (options: readonly AutomationCommandOptionSpec[]) => {
  const optionNames = new Set(options.map((option) => option.name));
  return [
    ...options,
    ...STANDARD_COMMAND_OPTIONS.filter((option) => !optionNames.has(option.name)),
  ];
};

const DASHBOARD_COMMAND_SPECS = [
  ...DASHBOARD_SHELL_COMMAND_SPECS,
  ...DASHBOARD_COMMAND_REFERENCES.map((reference) => ({
    ...reference.bash,
    options: appendStandardCommandOptions(reference.bash.options),
  })),
];

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

const appendPathSegment = (parentPath: string, name: string) =>
  parentPath === "/" ? `/${name}` : `${parentPath.replace(/\/+$/, "")}/${name}`;

const listPathAutocompleteEntries = async ({
  fileSystem,
  cwd,
  parentPath,
  query,
  directoriesOnly,
}: {
  fileSystem: IFileSystem;
  cwd: string;
  parentPath: string;
  query: string;
  directoriesOnly: boolean;
}): Promise<DashboardPathAutocompleteEntry[]> => {
  const resolvedParentPath = fileSystem.resolvePath(cwd, parentPath || ".");
  const dirents = fileSystem.readdirWithFileTypes
    ? await fileSystem.readdirWithFileTypes(resolvedParentPath)
    : await Promise.all(
        (await fileSystem.readdir(resolvedParentPath)).map(async (name) => {
          const stat = await fileSystem.stat(appendPathSegment(resolvedParentPath, name));
          return {
            name,
            isDirectory: stat.isDirectory,
          };
        }),
      );

  return dirents
    .filter((entry) => entry.name.startsWith(query))
    .filter((entry) => !directoriesOnly || entry.isDirectory)
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    })
    .slice(0, 8)
    .map((entry) => ({
      name: entry.name,
      path: appendPathSegment(resolvedParentPath, entry.name),
      isDirectory: entry.isDirectory,
    }));
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
  const intent = String(formData.get("intent") ?? "run-command");
  const command = String(formData.get("command") ?? "").trim();
  const cwdInput = String(formData.get("cwd") ?? "").trim();
  const cwd = cwdInput || DEFAULT_CWD;
  const activeOrg = me.activeOrganization?.organization;

  if (intent === "autocomplete-path") {
    const commandLine = String(formData.get("commandLine") ?? "");
    const cursorPositionInput = Number(formData.get("cursorPosition"));
    const cursorPosition = Number.isFinite(cursorPositionInput)
      ? cursorPositionInput
      : commandLine.length;
    const autocompleteRequest = getDashboardPathAutocompleteRequest({
      commandLine,
      cwd,
      cursorPosition,
    });
    const emptyResult = (error: string): DashboardPathAutocompleteResult => ({
      ...(autocompleteRequest ?? {
        intent: "autocomplete-path" as const,
        commandLine,
        cwd,
        cursorPosition,
        parentPath: "",
        query: "",
        replacementStart: cursorPosition,
        replacementEnd: cursorPosition,
        directoriesOnly: false,
      }),
      ok: false,
      entries: [],
      error,
    });

    if (!autocompleteRequest) {
      return emptyResult("No path completion is available for this command.");
    }

    if (!activeOrg) {
      return emptyResult(
        "No active organization selected. Choose an organization to use the PI filesystem.",
      );
    }

    try {
      const { runtime } = context.get(BackofficeWorkerContext);
      const kernel = new BackofficeKernel({ objects: runtime.objects });
      const execution = {
        actor: {
          type: "user" as const,
          id: me.user.id,
          userId: me.user.id,
          organizationIds: [activeOrg.id],
        },
        scope: { kind: "org" as const, orgId: activeOrg.id },
      };
      const fileSystem = await createBackofficeFileSystem({
        objects: runtime.objects,
        kernel,
        execution,
      });
      return {
        ...autocompleteRequest,
        ok: true,
        entries: await listPathAutocompleteEntries({
          fileSystem,
          cwd,
          parentPath: autocompleteRequest.parentPath,
          query: autocompleteRequest.query,
          directoriesOnly: autocompleteRequest.directoriesOnly,
        }),
      } satisfies DashboardPathAutocompleteResult;
    } catch (error) {
      return emptyResult(toErrorMessage(error));
    }
  }

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
    const { runtime } = context.get(BackofficeWorkerContext);
    const kernel = new BackofficeKernel({ objects: runtime.objects });
    const execution = {
      actor: {
        type: "user" as const,
        id: me.user.id,
        userId: me.user.id,
        organizationIds: [activeOrg.id],
      },
      scope: { kind: "org" as const, orgId: activeOrg.id },
    };
    const fileSystem = await createBackofficeFileSystem({
      objects: runtime.objects,
      kernel,
      execution,
    });
    const { bash } = createInteractiveBashHost({
      fs: fileSystem,
      context: createRouteBackedRuntimeContext({
        runtime,
        kernel,
        execution,
        defaultActor: {
          scope: "internal",
          type: "user",
          id: me.user.id,
        },
      }),
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
        description="Run commands in a terminal connected to the generated backoffice runtime-tool bash adapter."
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
          commandSpecs={DASHBOARD_COMMAND_SPECS}
        />

        <div className="space-y-4">
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Connected environment
            </p>
            <p className="mt-2 text-sm text-[var(--bo-muted)]">
              Runs inside the same filesystem used by Pi sessions with bash commands generated from
              the shared runtime-tool registry.
            </p>
          </div>

          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Supported quick checks
            </p>
            <ul className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
              <li>• ls, cat, find, pwd</li>
              <li>• isogit clone / status against the virtual filesystem</li>
              {DASHBOARD_COMMAND_GROUPS.map((group) => (
                <li key={group.namespace}>
                  • {group.namespace}: {group.commands.join(" / ")}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
