import { z } from "zod";

import type { Organization } from "@fragno-dev/auth";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { getAuthDurableObject } from "@/cloudflare/cloudflare-utils";
import { createOrgFileSystem } from "@/files/create-file-system";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { getAvailableBackofficeRuntimeTools } from "@/fragno/runtime-tools/tool-families";

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

const assertOrganizationExists = async (context: Route.ActionArgs["context"], orgId: string) => {
  const authDo = getAuthDurableObject(context) as unknown as {
    getAllOrganizations(): Promise<Organization[]>;
  };
  const organizations = await authDo.getAllOrganizations();

  if (!organizations.some((organization) => organization.id === orgId)) {
    throw Response.json(
      {
        error: "Organization not found",
        orgId,
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
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

  const body = await parseJsonBody(request);
  await assertOrganizationExists(context, orgId);

  const { env } = context.get(CloudflareContext);

  const fs = await createOrgFileSystem({ orgId, env });
  const routeRuntimeContext = createRouteBackedRuntimeContext({ env, orgId });
  const toolContext = createBackofficeToolContext(routeRuntimeContext);

  const result = await runBackofficeCodemode({
    code: body.code,
    fs,
    env,
    timeout: body.timeout,
    context: toolContext,
    tools: getAvailableBackofficeRuntimeTools(toolContext),
  });

  return Response.json(
    {
      ok: !result.error,
      result: result.result,
      error: result.error,
      logs: result.logs ?? [],
      toolCalls: result.toolCalls,
      workflowDefinition: result.workflowDefinition,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
