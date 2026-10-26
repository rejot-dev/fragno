import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { PostHog } from "posthog-node";
import {
  createContext,
  type RouterContext,
  type RouterContextProvider,
  type ServerInstrumentation,
} from "react-router";

import {
  backofficeScopeFields,
  type BackofficeScopeFields,
} from "./backoffice-runtime/backoffice-telemetry";

type BackofficePostHogRequest = {
  client: PostHog;
  requestId: string;
  userId: string | null;
  /** The matched route pattern, such as `/backoffice/dashboard/:scopeKind/:scopeId`. */
  route: string | null;
  /** The authenticated scope the request's URL names. */
  scope: BackofficeScopeFields | null;
  capturedErrors: WeakSet<Error>;
  waitUntil(promise: Promise<unknown>): void;
};

const contextKey = Symbol.for("fragno.backoffice.posthog-context");

/** Only the Cloudflare entry point installs a client; other runtimes inherit the null default. */
export const BackofficePostHogContext = ((globalThis as Record<symbol, unknown>)[contextKey] ??=
  createContext<BackofficePostHogRequest | null>(
    null,
  )) as RouterContext<BackofficePostHogRequest | null>;

/** Call once the scope a request's URL names is authenticated. */
export function recordBackofficeRequestScope(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): void {
  const analytics = context.get(BackofficePostHogContext);
  if (analytics) {
    analytics.scope = backofficeScopeFields(scope);
  }
}

/** Records the route React Router matched, so request events group by page, not by URL. */
export const backofficePostHogServerInstrumentation: ServerInstrumentation = {
  handler(handler) {
    handler.instrument({
      async request(execute, { context }) {
        const result = await execute();
        const analytics = context?.get(BackofficePostHogContext);
        if (analytics && result.meta) {
          analytics.route = result.meta.pattern;
        }
      },
    });
  },
};

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
