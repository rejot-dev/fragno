import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createMailingListFragmentClients } from "..";

export function createMailingListClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createMailingListFragmentClients(config));
}
