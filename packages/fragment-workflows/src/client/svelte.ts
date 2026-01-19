import { createWorkflowsClients } from "..";

import { useFragno } from "@fragno-dev/core/svelte";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createWorkflowsClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createWorkflowsClients(config));
}
