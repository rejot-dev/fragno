import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createAuthFragmentClients, type AuthFragmentClientConfig } from "..";

export function createAuthFragmentClient(config: AuthFragmentClientConfig = {}) {
  return createFragnoReactClient(createAuthFragmentClients(config));
}

export type {
  AuthMeData,
  AuthMeLike,
  DefaultOrganizationEntry,
  DefaultOrganizationPreferenceStore,
  DefaultOrganizationResolution,
  DefaultOrganizationResolutionStatus,
} from "..";
