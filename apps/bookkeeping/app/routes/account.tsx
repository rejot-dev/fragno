import { Button } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { useState } from "react";
import { useOutletContext } from "react-router";

import { authClient } from "../lib/auth-client";

export function meta() {
  return [{ title: "Account · Bookkeeping" }];
}

export default function Account() {
  const { user } = useOutletContext<{ user: typeof authClient.$Infer.Session.user }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Your account"
        description="Your profile and current session."
        breadcrumbs={[{ label: "Bookkeeping", to: "/dashboard" }, { label: "Account" }]}
      />
      <div className="max-w-2xl space-y-6">
        <FormContainer
          title="Profile"
          description="The details associated with your Bookkeeping account."
        >
          <dl className="grid gap-5 py-2 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--bo-muted)]">Name</dt>
              <dd className="mt-1 text-sm font-medium">{user.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--bo-muted)]">Email</dt>
              <dd className="mt-1 text-sm font-medium break-all">{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--bo-muted)]">Email status</dt>
              <dd className="mt-1 text-sm font-medium">
                {user.emailVerified ? "Verified" : "Not verified"}
              </dd>
            </div>
          </dl>
        </FormContainer>
        <FormContainer
          title="Session"
          description="Log out of Bookkeeping on this browser. This does not log you out of Backoffice."
        >
          <Button
            variant="secondary"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const result = await authClient.signOut();
                if (result.error) {
                  setError("Could not log out. Please try again.");
                  setPending(false);
                } else {
                  window.location.assign("/login");
                }
              } catch {
                setError("Could not connect. Please try again.");
                setPending(false);
              }
            }}
          >
            {pending ? "Logging out…" : "Log out"}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-[var(--bo-failed)]">
              {error}
            </p>
          )}
        </FormContainer>
      </div>
    </div>
  );
}
