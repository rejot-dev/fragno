import { useFragno } from "@fragno-dev/core/solid";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createPiFragmentClients } from "..";

export function createPiFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createPiFragmentClients(config));
}
