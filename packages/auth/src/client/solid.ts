import { useFragno } from "@fragno-dev/core/solid";

import { createAuthFragmentClients, type AuthFragmentClientConfig } from "..";

export function createAuthFragmentClient(config: AuthFragmentClientConfig = {}) {
  return useFragno(createAuthFragmentClients(config));
}

export type {
  AuthMeData,
  AuthMeLike,
  DefaultOrganizationEntry,
  DefaultOrganizationResolution,
  DefaultOrganizationResolutionStatus,
} from "..";
