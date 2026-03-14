import { useFragno } from "@fragno-dev/core/svelte";
import { createPiFragmentClients, type PiFragmentClientConfig } from "./clients";

export function createPiFragmentClient(config: PiFragmentClientConfig = {}) {
  return useFragno(createPiFragmentClients(config));
}
