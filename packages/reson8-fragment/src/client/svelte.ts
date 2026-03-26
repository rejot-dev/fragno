import { useFragno } from "@fragno-dev/core/svelte";

import type { Reson8FragmentClientConfig } from "./client";
import { createReson8FragmentClients } from "./client";

export function createReson8FragmentClient(config: Reson8FragmentClientConfig = {}) {
  return useFragno(createReson8FragmentClients(config));
}
