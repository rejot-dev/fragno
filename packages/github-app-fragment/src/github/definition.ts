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
      githubApiClient: deps.githubApiClient,
    }),
  )
  .provideHooks(({ defineHook }) => ({
    processWebhook: defineHook(createWebhookProcessor()),
  }))
  .build();
