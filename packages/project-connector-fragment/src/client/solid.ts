import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/solid";

import { createProjectConnectorFragmentClients } from "..";

/** Creates the Solid client for the ProjectConnector fragment. */
export function createProjectConnectorFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createProjectConnectorFragmentClients(config));
}
