import { useFragno } from "@fragno-dev/core/solid";
import { createMailingListFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createMailingListClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createMailingListFragmentClients(config));
}
