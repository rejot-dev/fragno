import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/solid";

import { createWorkflowUsageFragmentClients } from "..";

export function createWorkflowUsageFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createWorkflowUsageFragmentClients(config));
}
