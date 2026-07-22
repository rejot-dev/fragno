import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createFormsClients } from "..";

export function createFormsClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createFormsClients(config));
}
