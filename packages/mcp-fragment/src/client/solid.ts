import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/solid";

import { createMcpFragmentClients } from "..";

export function createMcpFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createMcpFragmentClients(config));
}
