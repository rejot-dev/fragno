import { useFragno } from "@fragno-dev/core/svelte";
import { createStripeFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createStripeFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createStripeFragmentClients(config));
}
