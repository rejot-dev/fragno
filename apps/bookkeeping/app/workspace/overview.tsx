import { ButtonLink } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Icon } from "@fragno-private/design-system/icon";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";
import { Link, useOutletContext } from "react-router";

import type { Route } from "./+types/overview";
import { canManage, requireWorkspace } from "./access.server";
import type { WorkspaceOutletContext } from "./layout";

export function meta() {
  return [{ title: "Overview · Bookkeeping" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { membership } = await requireWorkspace(request, params.slug);
  return {
    administrations: await env.WORKSPACES.getByName("workspaces").listAdministrations(
      membership.workspace.id,
    ),
    canCreate: canManage(membership.roles),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function WorkspaceOverview({ loaderData }: Route.ComponentProps) {
  const { user, workspace } = useOutletContext<WorkspaceOutletContext>();
  const { administrations, canCreate } = loaderData;
  const base = `/w/${workspace.slug}`;
  const create = canCreate && (
    <ButtonLink variant="accent" to={`${base}/administrations/new`}>
      New administration
    </ButtonLink>
  );
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title={workspace.name}
        description={`Welcome, ${user.name}. Each administration holds the books of one business.`}
        breadcrumbs={[{ label: workspace.name, to: base }, { label: "Overview" }]}
        actions={create}
      />
      {administrations.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Getting started"
          title="Set up your books"
          description={
            canCreate
              ? "Create an administration for your business to start its books."
              : "No administrations yet. An owner or admin of this workspace creates them."
          }
          actions={create}
        />
      ) : (
        <FormContainer title="Administrations">
          <ul className="divide-y divide-[var(--bo-border)]">
            {administrations.map((administration) => (
              <li key={administration.id}>
                <Link
                  to={`${base}/a/${administration.slug}`}
                  className="flex items-center gap-3 py-3 text-sm font-medium"
                >
                  <Icon name="book" className="size-4" />
                  {administration.name}
                </Link>
              </li>
            ))}
          </ul>
        </FormContainer>
      )}
    </div>
  );
}
