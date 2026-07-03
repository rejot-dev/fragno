import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/codemode";

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const devCodemodeBodySchema = z.object({
  code: z.string().min(1),
  timeout: z.number().int().positive().max(120_000).optional(),
});

const assertDevOnlyLocalRequest = (request: Request) => {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const hostname = new URL(request.url).hostname;
  if (!localHostnames.has(hostname)) {
    throw new Response("Not Found", { status: 404 });
  }
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

  const execution = await requireBackofficeContext(request, context, { kind: "org", orgId });

  const body = devCodemodeBodySchema.parse(await request.json());

  const { env, runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });

  const fs = await createBackofficeFileSystem({
    objects: runtime.objects,
    kernel,
    execution,
    config: runtime.config,
  });
  const routeRuntimeContext = createRouteBackedRuntimeContext({
    runtime,
    kernel,
    execution,
  });
  const toolContext = createBackofficeToolContext(routeRuntimeContext);

  const result = await runBackofficeCodemode({
    code: body.code,
    fs,
    env,
    timeout: body.timeout,
    toolContext: toolContext,
    families: runtimeToolFamilies,
  });

  const headers = new Headers({ "cache-control": "no-store" });

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
