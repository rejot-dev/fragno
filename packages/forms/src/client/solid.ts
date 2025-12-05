import { useFragno } from "@fragno-dev/core/solid";
import { createFormsClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createFormsClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createFormsClients(config));
}
