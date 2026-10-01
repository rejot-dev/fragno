import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createProjectConnectorFragmentClients } from "..";

/** Creates the React client for the ProjectConnector fragment. */
export function createProjectConnectorFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createProjectConnectorFragmentClients(config));
}
