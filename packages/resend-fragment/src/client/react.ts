import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createResendFragmentClients } from "..";

export function createResendFragmentClient(config: FragnoPublicClientConfig = {}) {
  return createFragnoReactClient(createResendFragmentClients(config));
}
