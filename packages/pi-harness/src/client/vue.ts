import { useFragno } from "@fragno-dev/core/vue";

import { createPiFragmentClients, type PiFragmentClientConfig } from "./clients";

export function createPiFragmentClient(config: PiFragmentClientConfig = {}) {
  return useFragno(createPiFragmentClients(config));
}
