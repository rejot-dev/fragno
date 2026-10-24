import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";
import type { RouterContextProvider } from "react-router";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

/** Names the scope's Upload backend instance, so browsers open a new replica when it changes. */
export async function fetchUploadAdapterIdentity(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeRoutableScope,
): Promise<string> {
  await requireBackofficeContext(request, context, scope);
  const uploadObject = getBackofficeObjects(context).upload.for(scope);
  const description = await fetchFragnoInternalDescription({
    internalUrl: resolveFragnoInternalUrls(new URL("/api/upload", request.url)).internal,
    signal: request.signal,
    fetch: (input, init) =>
      uploadObject.http.fetch(new Request(input, { ...init, headers: request.headers })),
  });

  return description.adapterIdentity;
}
