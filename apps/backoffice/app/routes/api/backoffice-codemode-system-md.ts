import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { authorizeBackofficeCodemodeContext } from "@/fragno/auth/backoffice-principal.server";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
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
  const fs = await createBackofficeFileSystem({
    objects: runtime.objects,
    kernel,
    execution,
    config: runtime.config,
  });

  return await renderCodemodeSystemPrompt({ state: fs });
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
