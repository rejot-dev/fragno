import { Button } from "@fragno-private/design-system/button";
import { useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { authClient } from "./auth-client";

/**
 * Starts signing in, returning to `returnTo` afterwards, or to this page if it fails. Backoffice
 * holds every Bookkeeping account; its sign-in page looks like Bookkeeping, asks for an email, and
 * creates the account for a new address, so this one button serves new and returning people alike.
 * With `email`, that page starts with the address filled in.
 */
export function SignInButton({ returnTo, email }: { returnTo: string; email: string | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const { pathname, search } = useLocation();

  async function signIn() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider: "backoffice",
        callbackURL: returnTo,
        errorCallbackURL: pathname + search,
        // OAuth's login_hint; the person can still change it.
        loginHint: email ?? undefined,
      });
      if (result.error) {
        setError("We couldn't start signing in. Please try again.");
        setPending(false);
      }
    } catch {
      setError("We couldn't connect. Check your internet connection and try again.");
      setPending(false);
    }
  }

  return (
    <div className="sign-in space-y-3">
      <Button
        variant="solid"
        className="w-full"
        type="button"
        disabled={pending}
        onClick={() => {
          void signIn();
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
