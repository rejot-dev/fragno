import { Button } from "@fragno-private/design-system/button";
import { useState } from "react";

import { authClient } from "./auth-client";

/**
 * Ends Bookkeeping's session in this browser, then opens `then`. Backoffice's own session is not
 * affected.
 */
export function SignOutButton({ then }: { then: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("Could not log out. Please try again.");
        setPending(false);
      } else {
        window.location.assign(then);
      }
    } catch {
      setError("Could not connect. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => {
          void signOut();
        }}
      >
        {pending ? "Logging out…" : "Log out"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-[var(--bo-failed)]">
          {error}
        </p>
      )}
    </div>
  );
}
