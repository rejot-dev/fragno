import { Button } from "@fragno-private/design-system/button";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { authClient } from "../lib/auth-client";

/**
 * Starts signing in. Backoffice holds every Bookkeeping account; its sign-in page looks like
 * Bookkeeping, asks for an email, and creates the account for a new address, so this one button
 * serves new and returning people alike.
 */
export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();

  return (
    <div className="sign-in space-y-3">
      <Button
        variant="solid"
        className="w-full"
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const result = await authClient.signIn.social({
              provider: "backoffice",
              callbackURL: "/dashboard",
              errorCallbackURL: "/login",
            });
            if (result.error) {
              setError("We couldn't start signing in. Please try again.");
              setPending(false);
            }
          } catch {
            setError("We couldn't connect. Check your internet connection and try again.");
            setPending(false);
          }
        }}
      >
        {pending ? "One moment…" : "Continue with email"}
      </Button>
      {(error || params.has("error")) && (
        <p role="alert" className="error">
          {error ?? "Signing in didn't finish. Please try again."}
        </p>
      )}
    </div>
  );
}
