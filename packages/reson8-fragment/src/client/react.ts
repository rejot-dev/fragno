import { createFragnoReactClient } from "@fragno-dev/core/react";

import type { Reson8FragmentClientConfig } from "./client";
import { createReson8FragmentClients } from "./client";

export function createReson8FragmentClient(config: Reson8FragmentClientConfig = {}) {
  return createFragnoReactClient(createReson8FragmentClients(config));
}
