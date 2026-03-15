import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/solid";

import { createTelegramFragmentClients } from "..";

export function createTelegramFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createTelegramFragmentClients(config));
}
