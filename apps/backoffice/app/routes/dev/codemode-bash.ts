import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  DASHBOARD_COMMAND_TIMEOUT_MS,
  DEFAULT_CWD,
  extractNextCwd,
  wrapDashboardCommand,
} from "../backoffice/dashboard-terminal";
import type { Route } from "./+types/codemode-bash";

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const devBashBodySchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
});

class DevBashCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms.`);
    this.name = "DevBashCommandTimeoutError";
  }
}

const assertDevOnlyLocalRequest = (request: Request) => {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const hostname = new URL(request.url).hostname;
  if (!localHostnames.has(hostname)) {
    throw new Response("Not Found", { status: 404 });
  }
};

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

export async function loader() {
  throw new Response("Method Not Allowed", { status: 405 });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertDevOnlyLocalRequest(request);

  const orgId = params.orgId?.trim();
  if (!orgId) {
    throw new Response("Missing organisation id", { status: 400 });
  }

  const auth = await authorizeAccessTokenForOrganization(request, context, orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const body = devBashBodySchema.parse(await request.json());
  const cwd = body.cwd ?? DEFAULT_CWD;
  const timeoutMs = body.timeout ?? DASHBOARD_COMMAND_TIMEOUT_MS;

  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const execution = await requireBackofficeContext(request, context, { kind: "org", orgId });
  const fs = await createBackofficeFileSystem({ objects: runtime.objects, kernel, execution });
  const { bash, commandCallsResult } = createInteractiveBashHost({
    fs,
    context: createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution,
      defaultActor: {
        scope: "internal",
        type: "user",
        id: auth.principal.user.id,
      },
    }),
  });

  const headers = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of auth.headers) {
    headers.append(name, value);
  }

  const startedAt = performance.now();
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      bash.exec(wrapDashboardCommand(body.command), {
        cwd,
        signal: abortController.signal,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          reject(new DevBashCommandTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
    const durationMs = Math.round(performance.now() - startedAt);
    const { stderr, nextCwd } = extractNextCwd(result.stderr, cwd);
    const exitCode = result.exitCode ?? 0;

    return Response.json(
      {
        ok: exitCode === 0,
        command: body.command,
        cwd,
        nextCwd,
        stdout: result.stdout ?? "",
        stderr: stderr ?? "",
        output: formatOutput(result.stdout, stderr),
        exitCode,
        durationMs,
        commandCalls: commandCallsResult,
      },
      { headers },
    );
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const timeout = error instanceof DevBashCommandTimeoutError;

    return Response.json(
      {
        ok: false,
        command: body.command,
        cwd,
        nextCwd: cwd,
        stdout: "",
        stderr: "",
        output: toErrorMessage(error),
        exitCode: timeout ? 124 : 1,
        durationMs,
        commandCalls: commandCallsResult,
      },
      { headers },
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
