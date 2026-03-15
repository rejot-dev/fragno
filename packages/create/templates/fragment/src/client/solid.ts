import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/solid";

import { createExampleFragmentClients } from "..";

export function createExampleFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createExampleFragmentClients(config));
}
