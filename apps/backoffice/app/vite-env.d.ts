interface ImportMetaEnv {
  readonly BACKOFFICE_TARGET: "cloudflare" | "node";
  readonly VITE_POSTHOG_PROJECT_TOKEN: string | undefined;
  readonly VITE_POSTHOG_HOST: string | undefined;
  readonly VITE_POSTHOG_APP_ORIGIN: string | undefined;
}
