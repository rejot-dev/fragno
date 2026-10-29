import { artifactKind, artifactName, artifactSourcePath } from "@/artifacts/kinds";
import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";

import { dashboardPath } from "../dashboard/path";

const WORKSPACE = "/workspace/";

/** Every page source of a workspace, at any depth. */
export const PAGE_SOURCES_GLOB = `${WORKSPACE}**/${artifactSourcePath("*", "page")}`;

/** What a page is called in routes and menus: `/workspace/reports/operations.page.js` is `reports/operations`. */
export function pageName(sourcePath: string): string {
  return artifactName(sourcePath.slice(WORKSPACE.length), "page");
}

/** The page a file path is the source of, or null for any other file; only workspace pages open. */
export function sourcePageName(path: string): string | null {
  return path.startsWith(WORKSPACE) && artifactKind(path) === "page" ? pageName(path) : null;
}

/** Pages open as a dashboard tab: `reports/operations` at `…/dashboard/<scope>/pages/reports/operations`. */
export function pagePath(scope: BackofficeResolvedScope, name: string): string {
  const dashboard = dashboardPath(backofficeRouteScopeFromResolvedScope(scope));
  return `${dashboard}/pages/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** The workspace source a page route names, or null when no file could have that name. */
export function pageSourcePath(name: string): string | null {
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return `${WORKSPACE}${artifactSourcePath(name, "page")}`;
}
