import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { resendFragmentDefinition, type ResendFragmentConfig } from "./definition";
import { resendRoutesFactory } from "./routes";

const routes = [resendRoutesFactory] as const;

export function createResendFragment(
  config: ResendFragmentConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(resendFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}

export function createResendFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(resendFragmentDefinition, fragnoConfig, routes);

  return {
    useNotes: b.createHook("/notes"),
    useCreateNote: b.createMutator("POST", "/notes"),
  };
}

export { resendFragmentDefinition } from "./definition";
export { resendRoutesFactory } from "./routes";
export { resendSchema } from "./schema";
export type { ResendFragmentConfig } from "./definition";
export type { FragnoRouteConfig } from "@fragno-dev/core";
