import { useFragno } from "@fragno-dev/core/vanilla";
import { createAuthFragmentClients } from "..";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

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
