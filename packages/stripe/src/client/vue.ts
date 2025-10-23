import { useFragno } from "@fragno-dev/core/vue";
import { createStripeFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createStripeFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createStripeFragmentClients(config));
}
