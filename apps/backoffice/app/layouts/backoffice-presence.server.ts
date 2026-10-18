import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import {
  type BackofficeObjectBindingName,
  type BackofficeObjectHandle,
  type BackofficeObjectRegistry,
  isBackofficeObjectAvailableInContext,
  type WarmableObject,
} from "@/backoffice-runtime/object-registry";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { getBackofficeShellRequest } from "./backoffice-shell-request.server";

/**
 * Records the request as its user's presence and, when they enter a scope, warms that scope's
 * objects ahead of the pages that use them. Best effort: it neither delays nor fails the request.
 */
export async function recordBackofficePresence(
  { url, context }: { url: URL; context: Readonly<RouterContextProvider> },
  next: () => Promise<Response>,
): Promise<Response> {
  const { me, resolvedScope } = getBackofficeShellRequest(context);
  const { runtime, ctx } = context.get(BackofficeWorkerContext);
  const organization = me.activeOrganization?.organization ?? null;
  const room = organization
    ? runtime.objects.presence.forOrg(organization.id)
    : runtime.objects.presence.forUser({ userId: me.user.id });
  const pageOrganizationId = backofficeScopeOrganization(resolvedScope)?.organization.id ?? null;
  const scope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);

  ctx.waitUntil(
    room.commands
      .recordActivity({
        user: { id: me.user.id, email: me.user.email },
        // Members see only pages in their own organization; personal and System pages stay private.
        path: pageOrganizationId === organization?.id ? url.pathname : null,
        scope,
      })
      .then(async ({ enteredScope }) => {
        if (enteredScope) {
          await warmScopeObjects(runtime.objects, scope);
        }
      })
      .catch((error: unknown) => {
        console.warn("Backoffice presence could not be recorded.", error);
      }),
  );
  return await next();
}

async function warmScopeObjects(objects: BackofficeObjectRegistry, scope: BackofficeContextScope) {
  // The objects behind the section pages. The layout itself already reaches Automations.
  const warmable: Array<
    [
      BackofficeObjectBindingName,
      { for(scope: BackofficeContextScope): BackofficeObjectHandle<WarmableObject> },
    ]
  > = [
    ["API", objects.api],
    ["CODEMODE", objects.codemode],
    ["PI_MANAGER", objects.piManager],
    ["SANDBOX_MANAGER", objects.sandboxManager],
    ["UPLOAD", objects.upload],
  ];
  await Promise.all(
    warmable
      .filter(([binding]) => isBackofficeObjectAvailableInContext(binding, scope))
      .map(([, scoped]) => scoped.for(scope).commands.warm()),
  );
}
