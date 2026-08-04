import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createUploadHelpers } from "@fragno-dev/upload/helpers";
import { createUploadFragmentClient } from "@fragno-dev/upload/react";

import type { UploadHelpers } from "@fragno-dev/upload";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

const scopedUploadMountRoute = (scope: BackofficeRoutableScope) =>
  `/api/upload-scoped/${backofficeContextScopeRoutePath(scope)}`;

export function createScopedUploadClient(
  scope: BackofficeRoutableScope,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createUploadFragmentClient> {
  return createUploadFragmentClient({
    ...config,
    mountRoute: scopedUploadMountRoute(scope),
  });
}

export function createScopedUploadHelpers(scope: BackofficeRoutableScope): UploadHelpers {
  const mountRoute = scopedUploadMountRoute(scope);
  return createUploadHelpers({
    buildUrl: (path) => `${mountRoute}${path}`,
    fetcher: fetch,
  });
}

export function createUploadClient(
  orgId: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createUploadFragmentClient> {
  return createUploadFragmentClient({
    ...config,
    mountRoute: `/api/upload/${orgId}`,
  });
}
