import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createMcpFragmentClients } from "..";

export function createMcpFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createMcpFragmentClients(config));
}
