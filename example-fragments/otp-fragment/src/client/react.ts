import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createOtpFragmentClients } from "..";

export function createOtpFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createOtpFragmentClients(config));
}
