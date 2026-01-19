import { useFragno } from "@fragno-dev/core/react";
import { createAiFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createAiClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createAiFragmentClients(config));
}
