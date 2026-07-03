/*
 * Pi terminal action handler — the server side of the terminal. Given a posted
 * form (a `run-command` or `autocomplete-path` intent) and the active org, it
 * spins up the org filesystem + interactive bash host, runs the command (or
 * lists path completions), and returns a `DashboardTerminalActionResult`.
 *
 * Server-only: it imports the bash host and filesystem. It is called exclusively
 * from route `action` exports (backoffice dashboard + Cadence exec), so the
 * React Router Vite plugin strips it from the client bundle.
 */

import type { RouterContextProvider } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { IFileSystem } from "@/files";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  type DashboardCommandResult,
  type DashboardCommandSpec,
  type DashboardPathAutocompleteEntry,
  type DashboardPathAutocompleteResult,
  type DashboardTerminalActionResult,
  DASHBOARD_COMMAND_TIMEOUT_MS,
  DEFAULT_CWD,
  extractNextCwd,
  getDashboardPathAutocompleteRequest,
  wrapDashboardCommand,
} from "./dashboard-terminal";
import {
  formatPiTerminalCommandHelp,
  formatPiTerminalHelp,
  getAvailablePiTerminalCommandSpecs,
  PI_TERMINAL_COMMAND_SPECS,
} from "./pi-terminal-specs";

/** The active organisation the terminal is scoped to (or null when none is selected). */
type ActiveOrg = { id: string; name?: string | null } | null;

/** The route action `context`: a router context provider we read worker runtime + auth from. */
type TerminalActionContext = Readonly<RouterContextProvider>;

class CommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms.`);
    this.name = "CommandTimeoutError";
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
          return { name, isDirectory: stat.isDirectory };
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

const handlePathAutocomplete = async ({
  formData,
  request,
  context,
  activeOrg,
}: {
  formData: FormData;
  request: Request;
  context: TerminalActionContext;
  activeOrg: ActiveOrg;
}): Promise<DashboardPathAutocompleteResult> => {
  const commandLine = String(formData.get("commandLine") ?? "");
  const cwdInput = String(formData.get("cwd") ?? "").trim();
  const cwd = cwdInput || DEFAULT_CWD;
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
    const execution = await requireBackofficeContext(request, context, {
      kind: "org",
      orgId: activeOrg.id,
    });
    const fileSystem = await createBackofficeFileSystem({
      objects: runtime.objects,
      kernel,
      execution,
      config: runtime.config,
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
    };
  } catch (error) {
    return emptyResult(toErrorMessage(error));
  }
};

type HelpInvocation = { commandName?: string };

/**
 * Match a bare `help` (optionally with a single command name). Only plain
 * invocations are intercepted — anything with pipes, redirects, or extra
 * arguments returns null and falls through to the real shell.
 */
const parseHelpInvocation = (command: string): HelpInvocation | null => {
  const match = /^help(?:\s+([\w.-]+))?$/.exec(command);
  if (!match) {
    return null;
  }
  return { commandName: match[1] };
};

/**
 * The commands to list for `help`. With an active org we can build the real
 * runtime context and list exactly the commands that are wired (and runnable);
 * without one, fall back to the static superset as a reference, since no command
 * actually runs until an org is selected.
 */
const resolveHelpCommandSpecs = async ({
  context,
  request,
  activeOrg,
  userId,
}: {
  context: TerminalActionContext;
  request: Request;
  activeOrg: ActiveOrg;
  userId: string;
}): Promise<DashboardCommandSpec[]> => {
  if (!activeOrg) {
    return PI_TERMINAL_COMMAND_SPECS;
  }

  try {
    const { runtime } = context.get(BackofficeWorkerContext);
    const kernel = new BackofficeKernel({ objects: runtime.objects });
    const execution = await requireBackofficeContext(request, context, {
      kind: "org",
      orgId: activeOrg.id,
    });
    const runtimeContext = createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution,
      defaultActor: { scope: "internal", type: "user", id: userId },
    });
    return getAvailablePiTerminalCommandSpecs(createBackofficeToolContext(runtimeContext));
  } catch {
    return PI_TERMINAL_COMMAND_SPECS;
  }
};

/**
 * `help` is a hardwired just-bash shell builtin that lists its own internal
 * builtins, not the commands we expose. Intercept it and render our curated
 * command reference instead, scoped to what is actually available.
 */
const getTerminalHelpOutput = async ({
  command,
  context,
  request,
  activeOrg,
  userId,
}: {
  command: string;
  context: TerminalActionContext;
  request: Request;
  activeOrg: ActiveOrg;
  userId: string;
}): Promise<string | null> => {
  const invocation = parseHelpInvocation(command);
  if (!invocation) {
    return null;
  }

  const specs = await resolveHelpCommandSpecs({ context, request, activeOrg, userId });

  if (!invocation.commandName) {
    return formatPiTerminalHelp(specs);
  }

  return (
    formatPiTerminalCommandHelp(invocation.commandName, specs) ??
    `No help available for '${invocation.commandName}'. Run 'help' to list commands.`
  );
};

const handleRunCommand = async ({
  formData,
  request,
  context,
  activeOrg,
  userId,
}: {
  formData: FormData;
  request: Request;
  context: TerminalActionContext;
  activeOrg: ActiveOrg;
  userId: string;
}): Promise<DashboardCommandResult> => {
  const command = String(formData.get("command") ?? "").trim();
  const cwdInput = String(formData.get("cwd") ?? "").trim();
  const cwd = cwdInput || DEFAULT_CWD;

  const failure = (output: string, exitCode = 1): DashboardCommandResult => ({
    intent: "run-command",
    ok: false,
    command,
    cwd,
    nextCwd: cwd,
    output,
    exitCode,
    durationMs: 0,
  });

  if (!command) {
    return failure("No command provided.");
  }

  const helpOutput = await getTerminalHelpOutput({ command, context, request, activeOrg, userId });
  if (helpOutput !== null) {
    return {
      intent: "run-command",
      ok: true,
      command,
      cwd,
      nextCwd: cwd,
      output: helpOutput,
      exitCode: 0,
      durationMs: 0,
    };
  }

  if (!activeOrg) {
    return failure(
      "No active organization selected. Choose an organization to use the PI filesystem.",
    );
  }

  try {
    const { runtime } = context.get(BackofficeWorkerContext);
    const kernel = new BackofficeKernel({ objects: runtime.objects });
    const execution = await requireBackofficeContext(request, context, {
      kind: "org",
      orgId: activeOrg.id,
    });
    const fileSystem = await createBackofficeFileSystem({
      objects: runtime.objects,
      kernel,
      execution,
      config: runtime.config,
    });
    const { bash } = createInteractiveBashHost({
      fs: fileSystem,
      context: createRouteBackedRuntimeContext({
        runtime,
        kernel,
        execution,
        defaultActor: { scope: "internal", type: "user", id: userId },
      }),
    });

    const startedAt = performance.now();
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        bash.exec(wrapDashboardCommand(command), { cwd, signal: abortController.signal }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort();
            reject(new CommandTimeoutError(DASHBOARD_COMMAND_TIMEOUT_MS));
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
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      return {
        intent: "run-command",
        ok: false,
        command,
        cwd,
        nextCwd: cwd,
        output: toErrorMessage(error),
        exitCode: error instanceof CommandTimeoutError ? 124 : 1,
        durationMs,
      };
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  } catch (error) {
    return failure(toErrorMessage(error));
  }
};

export type HandlePiTerminalActionArgs = {
  formData: FormData;
  request: Request;
  context: TerminalActionContext;
  activeOrg: ActiveOrg;
  userId: string;
};

/**
 * Route the posted form to the right handler. Both the dashboard and Cadence
 * route actions call this after authenticating and resolving the active org.
 */
export async function handlePiTerminalAction({
  formData,
  request,
  context,
  activeOrg,
  userId,
}: HandlePiTerminalActionArgs): Promise<DashboardTerminalActionResult> {
  const intent = String(formData.get("intent") ?? "run-command");

  if (intent === "autocomplete-path") {
    return handlePathAutocomplete({ formData, request, context, activeOrg });
  }

  return handleRunCommand({ formData, request, context, activeOrg, userId });
}
