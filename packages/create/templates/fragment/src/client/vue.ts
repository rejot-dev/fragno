import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vue";

import { createExampleFragmentClients } from "..";

export function createExampleFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createExampleFragmentClients(config));
}
