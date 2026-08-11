import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

// React Router reports matched pathnames decoded (e.g. a project scope id
// appears as "org-1:project-1", not "org-1%3Aproject-1"), so compare both
// sides in decoded form.
const decodePathname = (pathname: string) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

export const isPiSessionsPath = (scope: BackofficeContextScope, pathname: string) => {
  const sessionsBasePath = decodePathname(
    `/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions`,
  );
  const normalizedPath = decodePathname(pathname).replace(/\/+$/, "");
  return normalizedPath === sessionsBasePath || normalizedPath.startsWith(`${sessionsBasePath}/`);
};
