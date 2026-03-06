import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { githubAppSchema } from "../schema";
import type { GitHubAppFragmentConfig } from "./types";
import { createGitHubApiClient } from "./api";
import { createWebhookProcessor } from "./webhook-processing";

export type GitHubAppFragmentDependencies = {
  githubApiClient: ReturnType<typeof createGitHubApiClient>;
};
export type GitHubAppFragmentServices = {
  app: ReturnType<typeof createGitHubApiClient>["app"];
  githubApiClient: ReturnType<typeof createGitHubApiClient>;
};

export const githubAppFragmentDefinition = defineFragment<GitHubAppFragmentConfig>(
  "github-app-fragment",
)
  .extend(withDatabase(githubAppSchema))
  .withDependencies(({ config }) => ({
    githubApiClient: createGitHubApiClient(config),
  }))
  .providesBaseService(({ deps, defineService }) =>
    defineService({
      app: deps.githubApiClient.app,
      githubApiClient: deps.githubApiClient,
    }),
  )
  .provideHooks(({ defineHook, config }) => ({
    processWebhook: defineHook(
      createWebhookProcessor({
        webhook: config.webhook,
      }),
    ),
  }))
  .build();
