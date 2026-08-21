import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

import { toBackofficeScope, type AutomationUiScope } from "../automations/scope";

export type FilesUiScope = AutomationUiScope;

export const filesScopeBasePath = (scope: FilesUiScope): string =>
  `/backoffice/files/${backofficeContextScopeRoutePath(toBackofficeScope(scope))}`;

/** Appends a filesystem path to an already encoded scoped Files route. */
export function filesExplorerPathFromScopePath(
  filesScopePath: string,
  path?: string | null,
): string {
  const encodedPath = path?.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return encodedPath ? `${filesScopePath}/${encodedPath}` : filesScopePath;
}

export const filesExplorerPath = (scope: FilesUiScope, path?: string | null): string =>
  filesExplorerPathFromScopePath(filesScopeBasePath(scope), path);

export const filesDownloadPath = (scope: FilesUiScope, path: string): string => {
  const params = new URLSearchParams({ path });
  return `${filesScopeBasePath(scope)}/download?${params.toString()}`;
};
