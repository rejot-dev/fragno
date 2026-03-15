import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/svelte";

import { createTelegramFragmentClients } from "..";

export function createTelegramFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createTelegramFragmentClients(config));
}
