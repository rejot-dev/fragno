import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";

import { createResendFragmentClients } from "..";

export function createResendFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createResendFragmentClients(config));
}
