import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { githubAppRoutesFactory } from "../routes";
import { githubAppFragmentDefinition } from "./definition";

export type { GitHubAppFragmentPublicClientConfig } from "./types";

export function createGitHubAppFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(githubAppFragmentDefinition, fragnoConfig, [
    githubAppRoutesFactory,
  ]);

  return {
    useSyncInstallation: b.createMutator("POST", "/installations/:installationId/sync"),
  };
}
