import { useFragno } from "@fragno-dev/core/react";
import { createAuthFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createAuthFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createAuthFragmentClients(config));
}
