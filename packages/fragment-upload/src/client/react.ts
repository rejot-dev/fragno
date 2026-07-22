import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createUploadFragmentClients } from "./clients";

export function createUploadFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createUploadFragmentClients(config));
}
