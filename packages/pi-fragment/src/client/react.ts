import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createPiFragmentClients, type PiFragmentClientConfig } from "./clients";

export function createPiFragmentClient(config: PiFragmentClientConfig = {}) {
  return createFragnoReactClient(createPiFragmentClients(config));
}
