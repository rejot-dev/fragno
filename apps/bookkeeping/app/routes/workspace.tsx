import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useOutletContext } from "react-router";

import type { WorkspaceOutletContext } from "./workspace-layout";

export function meta() {
  return [{ title: "Overview · Bookkeeping" }];
}

export default function WorkspaceOverview() {
  const { user, workspace } = useOutletContext<WorkspaceOutletContext>();
  const base = `/w/${workspace.slug}`;
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title={workspace.name}
        description={`Welcome${user.name ? `, ${user.name}` : ""}. This is where ${workspace.name}'s books will live.`}
        breadcrumbs={[{ label: workspace.name, to: base }, { label: "Overview" }]}
        actions={
          <ButtonLink variant="secondary" to={`${base}/members`}>
            Members
          </ButtonLink>
        }
      />
      <BackofficeSystemState
        tone="empty"
        label="Getting started"
        title="Your books start here"
        description="Your workspace is ready. Transactions, accounts, and reports aren't available yet; this workspace will bring them together as they're added."
      />
    </div>
  );
}
