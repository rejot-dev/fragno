import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/svelte";

import { createWorkflowsClients } from "./clients";

export function createWorkflowsClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createWorkflowsClients(config));
}
