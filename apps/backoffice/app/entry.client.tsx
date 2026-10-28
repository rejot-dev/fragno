import { PostHogContext } from "@posthog/react/slim";
import type { PostHog } from "posthog-js";
import {
  startTransition,
  StrictMode,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { hydrateRoot } from "react-dom/client";
import type { ClientOnErrorFunction } from "react-router";
import { HydratedRouter } from "react-router/dom";

import { loadPostHog } from "@/posthog.client";

// Starts downloading the SDK now without making hydration wait for it.
const posthogLoad = loadPostHog();
const capturedRouteErrors = new WeakSet<Error>();

const onError: ClientOnErrorFunction = function reportClientError(error, { pattern, errorInfo }) {
  console.error(error, errorInfo);
  if (!(error instanceof Error) || capturedRouteErrors.has(error)) {
    return;
  }
  capturedRouteErrors.add(error);
  void posthogLoad.then((posthog) => {
    if (!posthog) {
      return;
    }
    try {
      // Route patterns describe the failure without exposing query strings or route parameter values.
      posthog.captureException(error, { route_pattern: pattern });
    } catch {
      console.warn("PostHog browser exception capture failed.");
    }
  });
};

/**
 * Provides the PostHog client once it loads. Until then it passes on the context's default, which
 * holds no client, so `usePostHog()` callers see one appear without the app remounting.
 */
function DeferredPostHogProvider({ children }: { children: ReactNode }) {
  const withoutClient = useContext(PostHogContext);
  const [client, setClient] = useState<PostHog | null>(null);
  useEffect(() => {
    void posthogLoad.then(setClient);
  }, []);
  const value = useMemo(() => (client ? { client } : withoutClient), [client, withoutClient]);
  return <PostHogContext value={value}>{children}</PostHogContext>;
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <DeferredPostHogProvider>
        <HydratedRouter onError={onError} />
      </DeferredPostHogProvider>
    </StrictMode>,
  );
});
