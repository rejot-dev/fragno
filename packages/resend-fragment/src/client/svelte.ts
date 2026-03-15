import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/svelte";

import { createResendFragmentClients } from "..";

export function createResendFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createResendFragmentClients(config));
}
