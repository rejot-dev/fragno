import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createTelegramFragmentClients } from "..";

import { useFragno } from "@fragno-dev/core/solid";

export function createTelegramFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createTelegramFragmentClients(config));
}
