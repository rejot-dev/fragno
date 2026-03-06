import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";

export type GitHubAppWebhookHandler<TEventName extends EmitterWebhookEventName> = (
  event: EmitterWebhookEvent<TEventName>,
  idempotencyKey: string,
) => void | Promise<void>;

export type GitHubAppWebhookOn = <TEventName extends EmitterWebhookEventName>(
  event: TEventName | TEventName[],
  handler: GitHubAppWebhookHandler<TEventName>,
) => void;

export type GitHubAppWebhookConfig = (register: GitHubAppWebhookOn) => void;

export type GitHubAppFragmentConfig = {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  webhookSecret: string;
  webhookDebug?: boolean;
  apiBaseUrl?: string;
  apiVersion?: string;
  webBaseUrl?: string;
  defaultLinkKey?: string;
  tokenCacheTtlSeconds?: number;
  webhook?: GitHubAppWebhookConfig;
};

export type GitHubAppFragmentPublicClientConfig = FragnoPublicClientConfig;
