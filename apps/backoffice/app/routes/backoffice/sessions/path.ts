import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

export const isPiSessionsPath = (scope: BackofficeContextScope, pathname: string) => {
  const sessionsBasePath = `/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions`;
  const normalizedPath = pathname.replace(/\/+$/, "");
  return normalizedPath === sessionsBasePath || normalizedPath.startsWith(`${sessionsBasePath}/`);
};
