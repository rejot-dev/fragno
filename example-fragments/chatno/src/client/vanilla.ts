import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";

import { createChatnoClients } from "..";

export function createChatnoClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createChatnoClients(config));
}
