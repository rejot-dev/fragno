import { FormContainer } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { useOutletContext } from "react-router";

import { SignOutButton } from "../auth/sign-out-button";
import type { WorkspaceOutletContext } from "./layout";

export function meta() {
  return [{ title: "Account · Bookkeeping" }];
}

export default function Account() {
  const { user, workspace } = useOutletContext<WorkspaceOutletContext>();
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Your account"
        description="Your profile and current session."
        breadcrumbs={[{ label: workspace.name, to: `/w/${workspace.slug}` }, { label: "Account" }]}
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
          </dl>
        </FormContainer>
        <FormContainer title="Session" description="Log out of Bookkeeping on this browser.">
          <SignOutButton then="/login" />
        </FormContainer>
      </div>
    </div>
  );
}
