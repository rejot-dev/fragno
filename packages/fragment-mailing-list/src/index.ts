import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { mailingListRoutesFactory } from "./routes";
import { mailingListFragmentDefinition } from "./definition";

export interface MailingListConfig {
  onSubscribe?: (email: string) => Promise<void> | void;
}

const routes = [mailingListRoutesFactory] as const;

export function createMailingListFragment(
  config: MailingListConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(mailingListFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createMailingListFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(mailingListFragmentDefinition, fragnoConfig, routes);

  return {
    useSubscribers: builder.createHook("/subscribers"),
    useSubscribe: builder.createMutator("POST", "/subscribe"),
  };
}

export { mailingListFragmentDefinition } from "./definition";
export type { SortField, SortOrder, GetSubscribersParams } from "./definition";
export type { FragnoRouteConfig } from "@fragno-dev/core";
