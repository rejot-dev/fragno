import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createUploadHelpers } from "@fragno-dev/upload/helpers";
import { createUploadFragmentClient } from "@fragno-dev/upload/react";

import type { UploadHelpers } from "@fragno-dev/upload";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRoutableResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

function scopedUploadMountRoute(scope: BackofficeRoutableResolvedScope): string {
  return `/api/upload-scoped/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(scope),
  )}`;
}

export function createScopedUploadClient(
  scope: BackofficeRoutableResolvedScope,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createUploadFragmentClient> {
  return createUploadFragmentClient({
    ...config,
    mountRoute: scopedUploadMountRoute(scope),
  });
}

export function createScopedUploadHelpers(scope: BackofficeRoutableResolvedScope): UploadHelpers {
  const mountRoute = scopedUploadMountRoute(scope);
  return createUploadHelpers({
    buildUrl: (path) => `${mountRoute}${path}`,
    fetcher: fetch,
  });
}

export function createUploadClient(
  orgSlug: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createUploadFragmentClient> {
  return createUploadFragmentClient({
    ...config,
    mountRoute: `/api/upload/${encodeURIComponent(orgSlug)}`,
  });
}
