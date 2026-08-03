import { createFetchFragnoOutboxTransport } from "@fragno-dev/tanstack-db-adapter/transport";
import type { RouterContextProvider } from "react-router";

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
  const url = new URL(request.url);
  url.pathname = "/api/upload/_internal";
  url.search = "";

  const transport = createFetchFragnoOutboxTransport({
    internalUrl: url,
    fetch: (input, init) =>
      uploadObject.fetch(new Request(input, { ...init, headers: request.headers })),
  });

  return transport.getAdapterIdentity({ signal: request.signal });
}
