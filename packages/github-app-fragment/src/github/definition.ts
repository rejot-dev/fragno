import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { githubAppSchema } from "../schema";
import { createGitHubApiClient } from "./api";
import { createGitHubServices } from "./services";
import type { GitHubAppFragmentConfig } from "./types";
import { createWebhookProcessor } from "./webhook-processing";

export type { GitHubAppFragmentDependencies, GitHubAppFragmentServices } from "./services";

export const githubAppFragmentDefinition = defineFragment<GitHubAppFragmentConfig>(
  "github-app-fragment",
)
  .extend(withDatabase(githubAppSchema))
  .withDependencies(({ config }) => ({
    githubApiClient: createGitHubApiClient(config),
  }))
  .providesBaseService(({ deps, defineService }) => createGitHubServices(deps, defineService))
  .provideHooks(({ defineHook, config }) => ({
    processWebhook: defineHook(
      createWebhookProcessor({
        webhook: config.webhook,
      }),
    ),
  }))
  .build();
