import { useFragno } from "@fragno-dev/core/vanilla";
import { createPiFragmentClients, type PiFragmentClientConfig } from "./clients";

export function createPiFragmentClient(config: PiFragmentClientConfig = {}) {
  return useFragno(createPiFragmentClients(config));
}
