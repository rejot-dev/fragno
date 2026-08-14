import type { RouterContextProvider } from "react-router";

import { fetchFragnoOutboxDescription } from "@fragno-dev/tanstack-db-adapter";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

export async function fetchUploadAdapterIdentity(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeRoutableScope,
): Promise<string> {
  await requireBackofficeContext(request, context, scope);
  const uploadObject = getBackofficeObjects(context).upload.for(scope);
  const baseUrl = new URL("/api/upload", request.url);
  const description = await fetchFragnoOutboxDescription({
    baseUrl,
    signal: request.signal,
    fetch: (input, init) =>
      uploadObject.fetch(new Request(input, { ...init, headers: request.headers })),
  });

  return description.adapterIdentity;
}
