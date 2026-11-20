import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  backofficeCodemodeInputSchema,
  executeInteractiveCodemode,
} from "@/fragno/codemode/interactive-execute";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/backoffice-codemode";

export async function loader() {
  throw new Response("Method Not Allowed", { status: 405 });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  const authorization = await authorizeBackofficeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }
  const { execution } = authorization;

  const body = backofficeCodemodeInputSchema.strip().parse(await request.json());

  const { runtime, kernel } = context.get(BackofficeWorkerContext);

  const result = await executeInteractiveCodemode({ body, execution, runtime, kernel });

  const headers = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }

  return Response.json(result, { headers });
}
