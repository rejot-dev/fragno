import { useFragno } from "@fragno-dev/core/vue";
import { createAuthFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createAuthFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createAuthFragmentClients(config));
}
