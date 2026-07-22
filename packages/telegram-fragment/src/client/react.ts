import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createTelegramFragmentClients } from "..";

export function createTelegramFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createTelegramFragmentClients(config));
}
