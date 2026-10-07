import type { PostHog } from "posthog-node";
import { z } from "zod";

const posthogConfigSchema = z.object({
  projectToken: z.string().startsWith("phc_"),
  host: z.url().refine((value) => new URL(value).protocol === "https:"),
});

/** Runtime credentials are deployment-only; frontend build variables never enable server capture. */
export async function createCloudflarePostHog(
  env: Pick<CloudflareEnv, "POSTHOG_PROJECT_TOKEN" | "POSTHOG_HOST">,
): Promise<PostHog | null> {
  if (
    import.meta.env.BACKOFFICE_TARGET !== "cloudflare" ||
    !import.meta.env.PROD ||
    !env.POSTHOG_PROJECT_TOKEN
  ) {
    return null;
  }

  const config = posthogConfigSchema.safeParse({
    projectToken: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST,
  });
  if (!config.success) {
    console.warn("PostHog backend capture is disabled: invalid runtime configuration.");
    return null;
  }

  try {
    const { PostHog } = await import("posthog-node");
    return new PostHog(config.data.projectToken, {
      host: config.data.host,
      flushAt: 100,
      flushInterval: 0,
      requestTimeout: 5_000,
      fetchRetryCount: 0,
      disableGeoip: true,
      enableExceptionAutocapture: false,
    });
  } catch {
    console.warn("PostHog backend capture could not initialize.");
    return null;
  }
}

/** Analytics delivery must not change an already committed application outcome. */
export async function shutdownCloudflarePostHog(client: PostHog): Promise<void> {
  try {
    await client.shutdown(6_000);
  } catch {
    console.warn("PostHog backend event delivery failed.");
  }
}
