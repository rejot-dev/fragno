import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createWorkflowsClients } from "./clients";

export function createWorkflowsClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createWorkflowsClients(config));
}
