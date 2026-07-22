import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createApiFragmentClients } from "..";

export function createApiFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createApiFragmentClients(config));
}
