import { useFragno } from "@fragno-dev/core/react";
import { createExampleFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createExampleFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createExampleFragmentClients(config));
}
