import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

const WORKSPACE = "/workspace/";

/**
 * Where Backoffice links to a site: `/workspace/tools/shop.site` at
 * `/backoffice/sites/<scope>/tools/shop.site/`, which sends the viewer to its address.
 */
export function siteHref(scope: BackofficeResolvedScope, sitePath: string): string {
  const name = sitePath.slice(WORKSPACE.length);
  const scopePath = backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope));
  return `/backoffice/sites/${scopePath}/${name.split("/").map(encodeURIComponent).join("/")}/`;
}
