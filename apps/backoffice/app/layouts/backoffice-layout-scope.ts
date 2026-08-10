import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeContextScopeFromRouteParams,
  BackofficeScopeCodecError,
} from "@/backoffice-runtime/scope-codec";

type BackofficeRouteScopeParams = {
  scopeKind?: string;
  scopeId?: string;
  orgId?: string;
};

export function resolveCurrentBackofficeScope({
  params,
  defaultScope,
}: {
  params: BackofficeRouteScopeParams;
  defaultScope: BackofficeContextScope;
}): BackofficeContextScope {
  if (params.scopeKind !== undefined || params.scopeId !== undefined) {
    const routeScope = backofficeContextScopeFromRouteParams(params);
    if (!routeScope) {
      throw new BackofficeScopeCodecError("A scoped Backoffice route did not provide a scope.");
    }
    return routeScope;
  }

  if (params.orgId) {
    return { kind: "org", orgId: params.orgId };
  }

  return defaultScope;
}
