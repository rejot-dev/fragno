import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/react";

import { createAuthFragmentClients } from "..";

export function createAuthFragmentClient(config: FragnoPublicClientConfig = {}) {
  return useFragno(createAuthFragmentClients(config));
}

export type {
  AuthMeData,
  AuthMeLike,
  DefaultOrganizationEntry,
  DefaultOrganizationPreferenceStore,
  DefaultOrganizationResolution,
  DefaultOrganizationResolutionStatus,
} from "..";
