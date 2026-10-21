import { artifactName, artifactSourcePath } from "@/artifacts/kinds";
import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

const WORKSPACE = "/workspace/";

/** Where a page opens: `/workspace/reports/operations.page.js` at `…/pages/<scope>/reports/operations`. */
export function pagePath(scope: BackofficeResolvedScope, sourcePath: string): string {
  const name = artifactName(sourcePath.slice(WORKSPACE.length), "page");
  const scopePath = backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope));
  return `/backoffice/pages/${scopePath}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** The workspace source a page route names, or null when no file could have that name. */
export function pageSourcePath(name: string): string | null {
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return `${WORKSPACE}${artifactSourcePath(name, "page")}`;
}
