import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vue";

import { createAuthFragmentClients } from "..";

export function createAuthFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createAuthFragmentClients(config));
}

export type {
  AuthMeData,
  AuthMeLike,
  DefaultOrganizationEntry,
  DefaultOrganizationResolution,
  DefaultOrganizationResolutionStatus,
} from "..";
