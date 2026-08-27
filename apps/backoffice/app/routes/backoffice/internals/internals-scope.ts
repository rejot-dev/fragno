import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";

/** Returns the Internals workspace root for one browser-routable Backoffice scope. */
export function internalsScopeBasePath(scope: BackofficeRouteScope): string {
  return `/backoffice/internals/${backofficeRouteScopePath(scope)}`;
}
