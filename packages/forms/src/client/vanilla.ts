import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";

import { createFormsClients } from "..";

export function createFormsClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createFormsClients(config));
}
