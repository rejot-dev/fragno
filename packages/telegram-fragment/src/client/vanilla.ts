import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";

import { createTelegramFragmentClients } from "..";

export function createTelegramFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createTelegramFragmentClients(config));
}
