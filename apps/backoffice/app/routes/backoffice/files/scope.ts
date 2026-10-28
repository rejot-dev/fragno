import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

export function filesScopeBasePath(scope: BackofficeResolvedScope): string {
  return `/backoffice/files/${backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope))}`;
}

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

export function filesPreviewPath(scope: BackofficeResolvedScope, path: string): string {
  return `${filesScopeBasePath(scope)}/preview?${new URLSearchParams({ path })}`;
}

export const filesDownloadPath = (
  scope: BackofficeScopeSelection,
  path: string,
  disposition: "attachment" | "inline",
): string => {
  const params = new URLSearchParams(disposition === "inline" ? { path, disposition } : { path });
  return `${filesScopeBasePath(scope)}/download?${params.toString()}`;
};

export const largeFilesPath = (scope: BackofficeResolvedScope): string =>
  `${filesScopeBasePath(scope)}/large-files`;

export function largeFileDownloadPath(scope: BackofficeResolvedScope, key: string): string {
  return `${largeFilesPath(scope)}/download?${new URLSearchParams({ key })}`;
}

export const largeFileUploadsPath = (scope: BackofficeContextScope): string =>
  `/api/files-scoped/${backofficeContextScopeRoutePath(scope)}/large-files/uploads`;
