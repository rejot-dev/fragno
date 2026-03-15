import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/solid";

import { createStripeFragmentClients } from "..";

export function createStripeFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createStripeFragmentClients(config));
}
