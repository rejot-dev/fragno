/**
 * Secrets a deployment may leave unset. Wrangler can only declare required secrets, so these are
 * absent from the generated `worker-configuration.d.ts`. Set them on deployed Workers with
 * `wrangler secret put`; Cloudflare dev and preview never load them from `.dev.vars`.
 */
interface CloudflareEnv {
  POSTHOG_PROJECT_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** Shared with the Rivet host, which exports each Durable Object through the objects Worker. */
  WORKER_MIGRATOR_TOKEN?: string;
}
