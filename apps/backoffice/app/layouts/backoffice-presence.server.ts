import {
  backofficeScopeOrganization,
  backofficeScopeRootOwner,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import {
  type BackofficeObjectBindingName,
  type BackofficeObjectHandle,
  isBackofficeObjectAvailableInContext,
  type WarmableCommands,
} from "@/backoffice-runtime/object-registry";
import {
  backofficeOrganizationContextScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
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
  const room = runtime.objects.presence.for(
    organization
      ? backofficeOrganizationContextScope(organization)
      : { kind: "user", userId: me.user.id, jurisdiction: me.user.jurisdiction },
  );
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
          await warmScopeObjects(runtime, scope);
        }
      })
      .catch((error: unknown) => {
        console.warn("Backoffice presence could not be recorded.", error);
      }),
  );
  return await next();
}

async function warmScopeObjects(
  { objects, config }: BackofficeRuntimeServices,
  scope: BackofficeContextScope,
) {
  // The objects behind the section pages. The layout itself already reaches Automations.
  const warmable: Array<
    [
      BackofficeObjectBindingName,
      { for(scope: BackofficeContextScope): BackofficeObjectHandle<WarmableCommands> },
    ]
  > = [
    ["API", objects.api],
    ["CODEMODE", objects.codemode],
    ["PI_MANAGER", objects.piManager],
    ["SANDBOX_MANAGER", objects.sandboxManager],
    ["UPLOAD", objects.upload],
  ];
  // Prompts and model calls check usage limits on the owner's ledger before they start.
  const owner = backofficeScopeRootOwner(scope);
  await Promise.all([
    ...warmable
      .filter(([binding]) => isBackofficeObjectAvailableInContext(binding, scope))
      .map(([, scoped]) => scoped.for(scope).commands.warm()),
    ...(owner && config.bindings.billing ? [objects.billing.for(owner).commands.warm()] : []),
  ]);
}
