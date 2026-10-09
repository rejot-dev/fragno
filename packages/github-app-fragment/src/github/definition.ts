import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type HookFn } from "@fragno-dev/db";

import { githubAppSchema } from "../schema";
import { createGitHubApiClient } from "./api";
import type { GitHubRepositoryLinkStatusChangedPayload } from "./repository-links";
import { createGitHubServices } from "./services";
import type { GitHubAppFragmentConfig } from "./types";
import { createWebhookProcessor, type WebhookProcessingPayload } from "./webhook-processing";

export type { GitHubAppFragmentDependencies, GitHubAppFragmentServices } from "./services";

export type GitHubAppHooksMap = {
  processWebhook: HookFn<WebhookProcessingPayload>;
  onRepositoryLinkStatusChanged: HookFn<GitHubRepositoryLinkStatusChangedPayload>;
};

export const githubAppFragmentDefinition = defineFragment<GitHubAppFragmentConfig>(
  "github-app-fragment",
)
  .extend(withDatabase(githubAppSchema))
  .withDependencies(({ config }) => ({
    githubApiClient: createGitHubApiClient(config, { fetch: config.fetch }),
  }))
  .provideHooks<GitHubAppHooksMap>(({ defineHook, config }) => ({
    processWebhook: defineHook(
      createWebhookProcessor({
        webhook: config.webhook,
      }),
    ),
    onRepositoryLinkStatusChanged: defineHook(async function (payload) {
      await config.onRepositoryLinkStatusChanged?.(payload, this);
    }),
  }))
  .providesBaseService(({ deps, defineService }) => createGitHubServices(deps, defineService))
  .build();
