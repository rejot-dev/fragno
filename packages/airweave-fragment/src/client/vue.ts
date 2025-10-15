import { useFragno } from "@fragno-dev/core/vue";
import { createAirweaveFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createAirweaveFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createAirweaveFragmentClients(config));
}
