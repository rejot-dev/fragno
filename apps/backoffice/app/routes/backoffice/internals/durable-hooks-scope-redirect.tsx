import { redirect } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeContextScopeFromRouteParams,
  BackofficeScopeCodecError,
} from "@/backoffice-runtime/scope-codec";

import type { Route } from "./+types/durable-hooks-scope-redirect";
import {
  defaultDurableHooksObjectForScope,
  durableHooksScopePath,
  getDurableHooksObjectDefinition,
  isDurableHooksObjectAllowedForScope,
} from "./durable-hooks-scope";

export async function loader({ params, url }: Route.LoaderArgs) {
  let scope: BackofficeContextScope | null;
  try {
    scope = backofficeContextScopeFromRouteParams(params);
  } catch (error) {
    if (error instanceof BackofficeScopeCodecError) {
      throw new Response("Not Found", { status: 404 });
    }
    throw error;
  }
  if (!scope) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestedObject = getDurableHooksObjectDefinition(url.searchParams.get("object"));
  const objectId =
    requestedObject && isDurableHooksObjectAllowedForScope(requestedObject.id, scope)
      ? requestedObject.id
      : defaultDurableHooksObjectForScope(scope);

  return redirect(durableHooksScopePath(scope, objectId));
}

export default function BackofficeDurableHooksScopeRedirect() {
  return null;
}
