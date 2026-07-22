import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createCloudflareFragmentClients } from "..";

export function createCloudflareFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createCloudflareFragmentClients(config));
}
