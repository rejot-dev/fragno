import { createPiFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createPiFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createPiFragmentClients(config);
}
