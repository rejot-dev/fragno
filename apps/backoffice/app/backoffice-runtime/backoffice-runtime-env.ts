import type { WorkerCompiler } from "./dynamic-workers/compile-worker";

/** Runtime bindings and configuration consumed by Backoffice objects and codemode execution. */
export type BackofficeRuntimeEnv = {
  LOADER?: WorkerLoader;
  compileWorker?: WorkerCompiler;
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
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
};
