import { useFragno } from "@fragno-dev/core/svelte";
import { createUploadFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createUploadFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createUploadFragmentClients(config));
}
