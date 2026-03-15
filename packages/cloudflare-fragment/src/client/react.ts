import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/react";

import { createCloudflareFragmentClients } from "..";

export function createCloudflareFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createCloudflareFragmentClients(config));
}
