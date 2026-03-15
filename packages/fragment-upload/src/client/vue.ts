import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vue";

import { createUploadFragmentClients } from "./clients";

export function createUploadFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createUploadFragmentClients(config));
}
