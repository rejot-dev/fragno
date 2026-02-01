import { useFragno } from "@fragno-dev/core/react";
import { createUploadFragmentClients } from "./clients";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createUploadFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createUploadFragmentClients(config));
}
