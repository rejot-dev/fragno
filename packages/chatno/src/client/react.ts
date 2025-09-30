import { useFragno } from "@fragno-dev/core/react";
import { createChatnoClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core";

export function createChatnoClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createChatnoClients(config));
}
