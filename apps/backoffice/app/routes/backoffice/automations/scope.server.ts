import type { RouterContextProvider } from "react-router";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { createBackofficeExecutionForPrincipal } from "@/fragno/auth/backoffice-principal.server";
import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";

import { automationRuntimeScopeFromRouteParams } from "./scope";

/** Establishes one JWT-authoritative automation route execution without loading memberships. */
export async function requireAutomationRouteExecution(
  request: Request,
  context: Readonly<RouterContextProvider>,
  params: { scopeKind?: string; scopeId?: string },
): Promise<BackofficeExecutionContext> {
  const principal = await requireBackofficePrincipal(request, context);
  const scope = automationRuntimeScopeFromRouteParams(
    params,
    principal.auth.organization ? [principal.auth.organization] : [],
  );
  return createBackofficeExecutionForPrincipal(principal, scope);
}
