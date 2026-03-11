import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";
import { createCloudflareFragmentClients } from "..";

export function createCloudflareFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createCloudflareFragmentClients(config));
}
