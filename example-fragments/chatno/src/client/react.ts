import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createChatnoClients } from "..";

export function createChatnoClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createChatnoClients(config));
}
