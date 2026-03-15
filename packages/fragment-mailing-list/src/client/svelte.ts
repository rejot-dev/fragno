import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/svelte";

import { createMailingListFragmentClients } from "..";

export function createMailingListClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createMailingListFragmentClients(config));
}
