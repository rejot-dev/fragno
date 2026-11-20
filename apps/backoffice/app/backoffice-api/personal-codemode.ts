import { backofficeCodemodeInputSchema } from "@fragno-dev/backoffice-api/v0/codemode";
import { z } from "zod";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  BackofficeExecutionTokenAuthenticationError,
  BackofficeExecutionTokenScopeError,
} from "@/fragno/auth/execution-token";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
import { executeInteractiveCodemode } from "@/fragno/codemode/interactive-execute";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";

import { apiError } from "./api-error";

export async function servePersonalCodemode(
  request: Request,
  { runtime, kernel }: { runtime: BackofficeRuntimeServices; kernel: BackofficeKernel },
): Promise<Response> {
  const bearer = /^Bearer\s+([^\s]+)$/iu.exec(request.headers.get("authorization") ?? "");
  if (!bearer) {
    return apiError("authentication_failed", "A Leyway CLI user sign-in is required.");
  }
  let scope;
  try {
    scope = await runtime.objects.auth.singleton().commands.authorizePersonalCodemode({
      requestUrl: request.url,
      oauthAccessToken: bearer[1],
    });
  } catch (error) {
    if (error instanceof Error && error.name === BackofficeExecutionTokenAuthenticationError.name) {
      return apiError("authentication_failed", error.message);
    }
    if (error instanceof Error && error.name === BackofficeExecutionTokenScopeError.name) {
      return apiError("forbidden", error.message);
    }
    throw error;
  }

  // Codemode context handles resolve live user permissions in the workspace they address.
  const execution = createBackofficeUserExecution({ scope, userId: scope.userId });
  if (request.method === "GET") {
    const state = createRuntimeStateBackend({ runtime, kernel, execution });
    return new Response(await renderCodemodeSystemPrompt({ state }), {
      headers: { "cache-control": "no-store", "content-type": "text/markdown; charset=utf-8" },
    });
  }

  const body: unknown = await request.json().catch(() => undefined);
  const parsed = backofficeCodemodeInputSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("invalid_request", z.prettifyError(parsed.error));
  }
  return Response.json(
    await executeInteractiveCodemode({ body: parsed.data, execution, runtime, kernel }),
    { headers: { "cache-control": "no-store" } },
  );
}
