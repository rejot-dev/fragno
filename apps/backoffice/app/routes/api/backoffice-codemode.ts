import { z } from "zod";

import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeCodemodeContext } from "@/fragno/auth/backoffice-principal.server";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/backoffice-codemode";

const backofficeCodemodeBodySchema = z.object({
  code: z.string().min(1),
  dependencies: z.record(z.string().min(1), z.string().min(1)).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
});

export async function loader() {
  throw new Response("Method Not Allowed", { status: 405 });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  const authorization = await authorizeBackofficeCodemodeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }
  const { execution } = authorization;

  const body = backofficeCodemodeBodySchema.parse(await request.json());

  const { env, runtime, kernel } = context.get(BackofficeWorkerContext);

  const routeRuntimeContext = createCodemodeRouteBackedRuntimeContext({
    runtime,
    kernel,
    execution: execution,
  });
  const toolContext = createBackofficeToolContext(routeRuntimeContext);

  const result = await runBackofficeCodemode({
    code: body.code,
    dependencies: body.dependencies,
    env,
    timeout: body.timeout,
    toolContext: toolContext,
    families: runtimeToolFamilies,
  });

  const headers = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }

  return Response.json(
    {
      ok: !result.error,
      result: result.result,
      error: result.error,
      logs: result.logs ?? [],
      toolCalls: result.toolCalls,
      workflowDefinition: result.workflowDefinition,
    },
    { headers },
  );
}
