import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/svelte";

import { createOtpFragmentClients } from "..";

export function createOtpFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createOtpFragmentClients(config));
}
