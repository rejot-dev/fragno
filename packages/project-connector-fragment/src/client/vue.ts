import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vue";

import { createProjectConnectorFragmentClients } from "..";

/** Creates the Vue client for the ProjectConnector fragment. */
export function createProjectConnectorFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createProjectConnectorFragmentClients(config));
}
