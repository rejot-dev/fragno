import { createWorkflowsClients } from "./clients";

import { useFragno } from "@fragno-dev/core/react";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createWorkflowsClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createWorkflowsClients(config));
}
