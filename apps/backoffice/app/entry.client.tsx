import { PostHogProvider } from "@posthog/react/slim";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import type { ClientOnErrorFunction } from "react-router";
import { HydratedRouter } from "react-router/dom";

import { initializePostHog } from "@/posthog.client";

const posthog = initializePostHog();
const capturedRouteErrors = new WeakSet<Error>();

const onError: ClientOnErrorFunction = function reportClientError(error, { pattern, errorInfo }) {
  console.error(error, errorInfo);
  if (!posthog || !(error instanceof Error) || capturedRouteErrors.has(error)) {
    return;
  }
  capturedRouteErrors.add(error);
  try {
    // Route patterns describe the failure without exposing query strings or route parameter values.
    posthog.captureException(error, { route_pattern: pattern });
  } catch {
    console.warn("PostHog browser exception capture failed.");
  }
};

startTransition(() => {
  const router = (
    <StrictMode>
      <HydratedRouter onError={onError} />
    </StrictMode>
  );
  hydrateRoot(
    document,
    posthog ? <PostHogProvider client={posthog}>{router}</PostHogProvider> : router,
  );
});
