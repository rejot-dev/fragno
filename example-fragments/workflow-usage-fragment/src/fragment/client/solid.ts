import { useFragno } from "@fragno-dev/core/solid";
import { createWorkflowUsageFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createWorkflowUsageFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createWorkflowUsageFragmentClients(config));
}
