import { z } from "zod";

import { createOrgFileSystem } from "@/files/create-file-system";
import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { getAvailableBackofficeRuntimeTools } from "@/fragno/runtime-tools/tool-families";
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

const parseJsonBody = async (request: Request) => {
  try {
    return devCodemodeBodySchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw Response.json(
        {
          error: "Invalid dev codemode request body",
          issues: error.issues,
        },
        { status: 400 },
      );
    }

    throw Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
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

  const auth = await authorizeAccessTokenForOrganization(request, context, orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await parseJsonBody(request);

  const { env, runtime } = context.get(BackofficeWorkerContext);

  const fs = await createOrgFileSystem({ orgId, objects: runtime.objects });
  const routeRuntimeContext = createRouteBackedRuntimeContext({ runtime, orgId });
  const toolContext = createBackofficeToolContext(routeRuntimeContext);

  const result = await runBackofficeCodemode({
    code: body.code,
    fs,
    env,
    timeout: body.timeout,
    context: toolContext,
    tools: getAvailableBackofficeRuntimeTools(toolContext),
  });

  const headers = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of auth.headers) {
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
