import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { automationScopeFromRouteParams } from "../backoffice/automations/scope";
import type { Route } from "./+types/codemode-system-md";

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const assertDevOnlyLocalRequest = (request: Request) => {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }

  const hostname = new URL(request.url).hostname;
  if (!localHostnames.has(hostname)) {
    throw new Response("Not Found", { status: 404 });
  }
};

const readOrgSystemGuidance = async ({
  context,
  execution,
}: {
  context: Route.LoaderArgs["context"];
  execution: BackofficeExecutionContext;
}) => {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const fs = await createBackofficeFileSystem({
    objects: runtime.objects,
    kernel,
    execution,
    config: runtime.config,
  });

  return await renderCodemodeSystemPrompt({ state: fs });
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  assertDevOnlyLocalRequest(request);

  const scope = automationScopeFromRouteParams(params);
  const authorization = await authorizeBackofficeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }
  const { execution } = authorization;

  const systemGuidance = await readOrgSystemGuidance({ context, execution });
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/markdown; charset=utf-8",
  });
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }
  return new Response(systemGuidance, { headers });
}
