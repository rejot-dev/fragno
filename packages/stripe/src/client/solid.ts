import { useFragno } from "@fragno-dev/core/solid";
import { createStripeFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createStripeFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createStripeFragmentClients(config));
}
