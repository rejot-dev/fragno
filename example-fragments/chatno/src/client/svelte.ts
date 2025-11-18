import { useFragno } from "@fragno-dev/core/svelte";
import { createChatnoClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createChatnoClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createChatnoClients(config));
}
