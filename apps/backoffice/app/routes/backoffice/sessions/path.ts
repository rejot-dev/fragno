import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

// React Router reports matched pathnames decoded once (e.g. a project scope id
// appears as "org-1:project-1", not "org-1%3Aproject-1"). Never decode the
// incoming pathname again — scope ids can contain encoded characters that a
// second decode would corrupt — so compare it against both the encoded and the
// once-decoded base path.
const decodePathname = (pathname: string) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

const matchesBasePath = (pathname: string, basePath: string) =>
  pathname === basePath || pathname.startsWith(`${basePath}/`);

export const isPiSessionsPath = (scope: BackofficeContextScope, pathname: string) => {
  const encodedBasePath = `/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions`;
  const decodedBasePath = decodePathname(encodedBasePath);
  const normalizedPath = pathname.replace(/\/+$/, "");
  return (
    matchesBasePath(normalizedPath, encodedBasePath) ||
    matchesBasePath(normalizedPath, decodedBasePath)
  );
};
