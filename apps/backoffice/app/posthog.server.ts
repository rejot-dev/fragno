import type { PostHog } from "posthog-node";
import { createContext, type RouterContext, type RouterContextProvider } from "react-router";

type BackofficePostHogRequest = {
  client: PostHog;
  requestId: string;
  userId: string | null;
  capturedErrors: WeakSet<Error>;
  waitUntil(promise: Promise<unknown>): void;
};

const contextKey = Symbol.for("fragno.backoffice.posthog-context");

/** Only the Cloudflare entry point installs a client; other runtimes inherit the null default. */
export const BackofficePostHogContext = ((globalThis as Record<symbol, unknown>)[contextKey] ??=
  createContext<BackofficePostHogRequest | null>(
    null,
  )) as RouterContext<BackofficePostHogRequest | null>;

/** Call after successful server operations, with identity from established request authority. */
export function captureBackofficeServerEvent(
  context: Readonly<RouterContextProvider>,
  input: {
    event: string;
    userId: string;
    properties: Record<string, string | number | boolean | null>;
  },
): void {
  const analytics = context.get(BackofficePostHogContext);
  if (!analytics) {
    return;
  }

  try {
    analytics.client.capture({
      distinctId: input.userId,
      event: input.event,
      properties: {
        ...input.properties,
        request_id: analytics.requestId,
        source: "cloudflare-worker",
        $process_person_profile: false,
      },
    });
  } catch {
    console.warn("PostHog backend event capture failed.");
  }
}

export function captureBackofficeServerException(
  context: Readonly<RouterContextProvider>,
  error: unknown,
): void {
  const analytics = context.get(BackofficePostHogContext);
  if (!analytics || !(error instanceof Error) || analytics.capturedErrors.has(error)) {
    return;
  }

  analytics.capturedErrors.add(error);
  try {
    // Rendering can fail after headers were returned and the request's event batch was shut down.
    analytics.waitUntil(
      analytics.client
        .captureExceptionImmediate(error, analytics.userId ?? analytics.requestId, {
          request_id: analytics.requestId,
          source: "cloudflare-worker",
          $process_person_profile: false,
        })
        .catch(() => {
          console.warn("PostHog backend exception delivery failed.");
        }),
    );
  } catch {
    console.warn("PostHog backend exception capture failed.");
  }
}
