import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";

import { createProjectConnectorFragmentClients } from "..";

/** Creates the vanilla JavaScript client for the ProjectConnector fragment. */
export function createProjectConnectorFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createProjectConnectorFragmentClients(config));
}
