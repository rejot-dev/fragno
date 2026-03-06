import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

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
};

export type GitHubAppFragmentPublicClientConfig = FragnoPublicClientConfig;
