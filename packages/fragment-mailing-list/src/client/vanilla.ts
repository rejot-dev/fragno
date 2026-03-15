import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";

import { createMailingListFragmentClients } from "..";

export function createMailingListClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createMailingListFragmentClients(config));
}
