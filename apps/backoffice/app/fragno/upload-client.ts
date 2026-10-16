import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createUploadHelpers } from "@fragno-dev/upload/helpers";
import { createUploadFragmentClient } from "@fragno-dev/upload/react";

import type { UploadHelpers } from "@fragno-dev/upload";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

function scopedUploadMountRoute(scope: BackofficeRoutableScope): string {
  return `/api/upload-scoped/${backofficeContextScopeRoutePath(scope)}`;
}

export function createScopedUploadHelpers(scope: BackofficeRoutableScope): UploadHelpers {
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
