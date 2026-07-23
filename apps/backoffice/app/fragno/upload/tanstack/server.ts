import { createFetchFragnoOutboxTransport } from "@fragno-dev/tanstack-db-adapter/transport";
import type { RouterContextProvider } from "react-router";

import { getUploadDurableObject } from "@/worker-runtime/durable-objects";

export async function fetchUploadAdapterIdentity(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<string> {
  const uploadDo = getUploadDurableObject(context, orgId);
  const url = new URL(request.url);
  url.pathname = "/api/upload/_internal";
  url.search = "";

  const transport = createFetchFragnoOutboxTransport({
    internalUrl: url,
    fetch: (input, init) =>
      uploadDo.fetch(new Request(input, { ...init, headers: request.headers })),
  });

  return transport.getAdapterIdentity({ signal: request.signal });
}
