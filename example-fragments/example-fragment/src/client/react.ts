import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createExampleFragmentClients } from "..";

export function createExampleFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createExampleFragmentClients(config));
}
