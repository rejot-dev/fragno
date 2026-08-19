import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vue";

import { createApiFragmentClients } from "./client";

export function createApiFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createApiFragmentClients(config));
}
