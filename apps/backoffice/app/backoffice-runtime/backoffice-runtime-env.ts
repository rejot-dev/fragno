import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";

/** Runtime bindings and configuration consumed by Backoffice objects and codemode execution. */
export type BackofficeRuntimeEnv = {
  codemode: BackofficeCodemodeEnv | null;
  DOCS_PUBLIC_BASE_URL?: string;
  TURNSTILE_SITEKEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_ACCESS_TOKEN_SECRET?: string;
  BACKOFFICE_INTERNAL_REQUEST_SECRET?: string;
  AUTH_ADMIN_GRANT_TOKEN?: string;
  AUTH_EMAIL_VERIFICATION_ENABLED?: string;
  SIGN_UP_INVITATIONS_ENABLED?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  CLOUDFLARE_WORKERS_ACCOUNT_ID?: string;
  CLOUDFLARE_WORKERS_API_TOKEN?: string;
  OOMOL_CONNECTOR_BASE_URL?: string;
  OOMOL_PROJECT_API_KEY?: string;
  OOMOL_CONNECTOR_CATALOG_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
};
