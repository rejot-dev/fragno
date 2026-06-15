import type { RouterContextProvider } from "react-router";

import type {
  BackofficeExecutionContext,
  BackofficePrincipal,
  BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { createBackofficeKernel } from "@/backoffice-runtime/kernel";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { requireAuthPrincipal, type BackofficeAuthPrincipal } from "./access-token.server";

export const createBackofficePrincipal = (auth: BackofficeAuthPrincipal): BackofficePrincipal => ({
  type: "user",
  id: auth.user.id,
  userId: auth.user.id,
  email: auth.user.email,
  role: auth.user.role,
  activeOrganizationId: auth.auth.activeOrganizationId,
  organizationIds: auth.auth.sessionContext.organizationIds,
});

export const requireBackofficePrincipal = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
): Promise<BackofficePrincipal> =>
  createBackofficePrincipal(await requireAuthPrincipal(request, routerContext));

export const requireBackofficeContext = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<BackofficeExecutionContext> => {
  const actor = await requireBackofficePrincipal(request, routerContext);
  createBackofficeKernel({
    objects: routerContext.get(BackofficeWorkerContext).runtime.objects,
  }).assertContextAccess({ actor, scope });
  return { actor, scope };
};
