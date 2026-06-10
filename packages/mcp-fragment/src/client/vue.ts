import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vue";

import { createMcpFragmentClients } from "..";

export function createMcpFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createMcpFragmentClients(config));
}
