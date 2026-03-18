import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { resendFragmentDefinition } from "./definition";
import type { ResendFragmentConfig } from "./definition";
import { resendRoutesFactory } from "./routes";
import type {
  ResendDomain,
  ResendDomainDetail,
  ResendDomainRecord,
  ResendEmailInput,
  ResendEmailDetail,
  ResendEmailRecord,
  ResendEmailSummary,
  ResendListDomainsOutput,
  ResendListEmailsOutput,
  ResendSendEmailInput,
} from "./routes";

const routes = [resendRoutesFactory] as const;

export function createResendFragment(
  config: ResendFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(resendFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}

export function createResendFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(resendFragmentDefinition, fragnoConfig, routes);

  return {
    useDomains: builder.createHook("/domains"),
    useDomain: builder.createHook("/domains/:domainId"),
    useEmails: builder.createHook("/emails"),
    useEmail: builder.createHook("/emails/:emailId"),
    useSendEmail: builder.createMutator("POST", "/emails"),
  };
}

export { resendFragmentDefinition } from "./definition";
export { resendRoutesFactory } from "./routes";
export { resendSchema } from "./schema";
export type { ResendFragmentConfig } from "./definition";
export type {
  ResendDomain,
  ResendDomainDetail,
  ResendDomainRecord,
  ResendEmailInput,
  ResendEmailDetail,
  ResendEmailRecord,
  ResendEmailSummary,
  ResendListDomainsOutput,
  ResendListEmailsOutput,
  ResendSendEmailInput,
};
export type { FragnoRouteConfig } from "@fragno-dev/core";
