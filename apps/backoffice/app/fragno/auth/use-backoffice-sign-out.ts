import { usePostHog } from "@posthog/react/slim";

import { authClient } from "./auth-client";

/**
 * Signs the browser out of Backoffice, forgets who analytics followed, and opens the login page,
 * which a full load reaches with no cached page state left behind.
 */
export function useBackofficeSignOut() {
  const posthog = usePostHog();
  const { mutate, loading, error } = authClient.useSignOut();
  return {
    signOut: () => {
      void mutate({ body: {} })
        .then(() => {
          if (posthog) {
            posthog.reset();
          }
          window.location.replace("/backoffice/login");
        })
        .catch(() => undefined);
    },
    signingOut: loading,
    error,
  };
}
