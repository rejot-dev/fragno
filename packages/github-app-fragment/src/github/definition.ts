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
  // Dependencies are built only for server instances; clients read the routes without a config.
  .withDependencies(({ config }) => {
    if (
      !Number.isSafeInteger(config.webhookDeliveryRetentionMs) ||
      config.webhookDeliveryRetentionMs <= 0
    ) {
      throw new Error(
        `webhookDeliveryRetentionMs must be a positive whole number of milliseconds, got ${config.webhookDeliveryRetentionMs}.`,
      );
    }
    return {
      githubApiClient: createGitHubApiClient(config, { fetch: config.fetch }),
      webhookDeliveryRetentionMs: config.webhookDeliveryRetentionMs,
    };
  })
  .providesBaseService(({ deps, defineService }) => createGitHubServices(deps, defineService))
  .provideHooks<GitHubAppHooksMap>(({ defineHook, config, services }) => ({
    processWebhook: defineHook(createWebhookProcessor({ webhook: config.webhook }, services)),
    onRepositoryLinkStatusChanged: defineHook(async function (payload) {
      await config.onRepositoryLinkStatusChanged?.(payload, this);
    }),
  }))
  .build();
