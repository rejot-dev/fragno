import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeCodemodeContext } from "@/fragno/auth/backoffice-principal.server";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/backoffice-codemode-system-md";

const readOrgSystemGuidance = async ({
  context,
  execution,
}: {
  context: Route.LoaderArgs["context"];
  execution: BackofficeExecutionContext;
}) => {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const state = createRuntimeStateBackend({ runtime, kernel, execution });
  return await renderCodemodeSystemPrompt({ state });
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  const authorization = await authorizeBackofficeCodemodeContext(request, context, scope);
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
