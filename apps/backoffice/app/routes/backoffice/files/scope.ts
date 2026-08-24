import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

export const filesScopeBasePath = (scope: BackofficeScopeSelection): string =>
  `/backoffice/files/${backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope))}`;

/** Appends a filesystem path to an already encoded scoped Files route. */
export function filesExplorerPathFromScopePath(
  filesScopePath: string,
  path?: string | null,
): string {
  const encodedPath = path?.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return encodedPath ? `${filesScopePath}/${encodedPath}` : filesScopePath;
}

export const filesExplorerPath = (scope: BackofficeScopeSelection, path?: string | null): string =>
  filesExplorerPathFromScopePath(filesScopeBasePath(scope), path);

export const filesDownloadPath = (scope: BackofficeScopeSelection, path: string): string => {
  const params = new URLSearchParams({ path });
  return `${filesScopeBasePath(scope)}/download?${params.toString()}`;
};
