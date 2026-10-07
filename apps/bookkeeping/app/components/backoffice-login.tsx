import { Button } from "@fragno-private/design-system/button";
import { BackofficeFragmentMark } from "@fragno-private/design-system/fragment-mark";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { authClient } from "../lib/auth-client";

export function BackofficeLogin() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();

  return (
    <div className="backoffice-login">
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
              setError("Could not start Backoffice login. Please try again.");
              setPending(false);
            }
          } catch {
            setError("Could not connect. Please try again.");
            setPending(false);
          }
        }}
      >
        <BackofficeFragmentMark size="md" className="[&>span]:bg-current!" />
        {pending ? "Opening Backoffice…" : "Continue with Backoffice"}
      </Button>
      {(error || params.has("error")) && (
        <p role="alert" className="error">
          {error ?? "Backoffice login did not complete. Please try again."}
        </p>
      )}
      <p>Or use your email and password below.</p>
    </div>
  );
}
