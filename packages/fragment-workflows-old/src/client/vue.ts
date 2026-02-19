import { createWorkflowsClients } from "./clients";

import { useFragno } from "@fragno-dev/core/vue";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createWorkflowsClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createWorkflowsClients(config));
}
