import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/react";

import { createApiFragmentClients } from "..";

export function createApiFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createApiFragmentClients(config));
}
