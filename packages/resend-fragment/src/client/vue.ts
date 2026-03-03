import { useFragno } from "@fragno-dev/core/vue";
import { createResendFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createResendFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createResendFragmentClients(config));
}
