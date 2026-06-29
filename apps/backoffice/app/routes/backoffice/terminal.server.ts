import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem, type IFileSystem } from "@/files";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

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

class BackofficeTerminalCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms.`);
    this.name = "BackofficeTerminalCommandTimeoutError";
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

export const runBackofficeTerminalAction = async ({
  request,
  context,
  scope,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
}) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "run-command");
  const command = String(formData.get("command") ?? "").trim();
  const cwdInput = String(formData.get("cwd") ?? "").trim();
  const cwd = cwdInput || DEFAULT_CWD;

  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const execution = await requireBackofficeContext(request, context, scope);

  if (intent === "autocomplete-path") {
    const commandLine = String(formData.get("commandLine") ?? "");
    const rawCursorPosition = formData.get("cursorPosition");
    const cursorPositionInput =
      typeof rawCursorPosition === "string" && rawCursorPosition.trim()
        ? Number(rawCursorPosition)
        : Number.NaN;
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

    try {
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

  try {
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
          id: execution.actor.type === "user" ? execution.actor.userId : execution.actor.id,
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
            reject(new BackofficeTerminalCommandTimeoutError(DASHBOARD_COMMAND_TIMEOUT_MS));
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
        exitCode: error instanceof BackofficeTerminalCommandTimeoutError ? 124 : 1,
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
};
