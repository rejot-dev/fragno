import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useOutletContext } from "react-router";

import type { authClient } from "../lib/auth-client";

export function meta() {
  return [{ title: "Overview · Bookkeeping" }];
}

export default function Dashboard() {
  const { user } = useOutletContext<{ user: typeof authClient.$Infer.Session.user }>();
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Your workspace"
        description={`Welcome, ${user.name}. This is your home for Bookkeeping.`}
        breadcrumbs={[{ label: "Bookkeeping", to: "/dashboard" }, { label: "Overview" }]}
        actions={
          <ButtonLink variant="secondary" to="/dashboard/account">
            View account
          </ButtonLink>
        }
      />
      <BackofficeSystemState
        tone="empty"
        label="Getting started"
        title="Your books start here"
        description="Your account is ready. Transactions, accounts, and reports aren't available yet; this workspace will bring them together as they're added."
      />
      <section className="bo-panel-surface rounded-[6px] bg-[var(--bo-panel)] p-5">
        <h2 className="text-base font-semibold">Account details</h2>
        <p className="mt-2 text-sm text-[var(--bo-muted)]">
          You're signed in as{" "}
          <span className="font-medium break-all text-[var(--bo-fg)]">{user.email}</span>. Manage
          your session and review your profile on the account page.
        </p>
        <ButtonLink variant="ghost" to="/dashboard/account" className="mt-3">
          Open account settings
        </ButtonLink>
      </section>
    </div>
  );
}
