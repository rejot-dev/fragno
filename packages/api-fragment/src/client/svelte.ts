import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/svelte";

import { createApiFragmentClients } from "..";

export function createApiFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createApiFragmentClients(config));
}
