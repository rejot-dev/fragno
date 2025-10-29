import { useFragno } from "@fragno-dev/core/vanilla";
import { createStripeFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createStripeFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createStripeFragmentClients(config));
}
