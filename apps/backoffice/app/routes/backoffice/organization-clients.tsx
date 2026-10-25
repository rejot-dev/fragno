import {
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Link, useOutletContext } from "react-router";

import { dashboardPath } from "./dashboard/path";
import type { OrganizationLayoutContext } from "./organization-layout";
import { formatDate, formatRoles } from "./organization-utils";

export function meta() {
  return [{ title: "Organization Clients" }];
}

const CLIENT_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Organization", align: "start" },
  { label: "Your roles", align: "start" },
  { label: "Members", align: "start" },
  { label: "Created", align: "start" },
  { label: "Open", align: "end" },
];

/**
 * The organizations this one manages, which its members act in without belonging to them. The
 * layout lists them only to the organization's own members, since managing does not chain.
 */
export default function BackofficeOrganizationClients() {
  const { organization, me, relations } = useOutletContext<OrganizationLayoutContext>();
  const clients = relations.managedOrganizations;
  const rolesById = new Map(
    me.organizations.map((entry) => [entry.organization.id, entry.roles] as const),
  );

  return (
    <SurfacePanel
      caption={`${clients.length} ${clients.length === 1 ? "client" : "clients"}`}
      actions={null}
    >
      {clients.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title={`${organization.name} manages no organizations.`}
          description="A system administrator lets an organization manage another with admin.org.manager.set. Its members then act in it without being invited."
          flush
        />
      ) : (
        <SurfaceTable columns={CLIENT_COLUMNS}>
          {clients.map((client) => {
            const roles = rolesById.get(client.organizationId) ?? null;
            return (
              <SurfaceTableRow
                key={client.organizationId}
                columns={CLIENT_COLUMNS}
                cells={[
                  <Link
                    key="organization"
                    to={`/backoffice/organizations/${encodeURIComponent(client.slug)}`}
                    className="group block max-w-[24rem] min-w-0"
                  >
                    <span className="block truncate font-semibold text-[var(--bo-fg)] group-hover:underline">
                      {client.name}
                    </span>
                    <span className="block truncate font-mono text-[11px]">{client.slug}</span>
                  </Link>,
                  roles ? formatRoles(roles) : "—",
                  <span key="members" className="tabular-nums">
                    {client.memberCount}
                  </span>,
                  <span key="created" className="whitespace-nowrap">
                    {formatDate(client.createdAt)}
                  </span>,
                  <Link
                    key="open"
                    to={dashboardPath({ kind: "org", orgSlug: client.slug })}
                    className="font-semibold whitespace-nowrap text-[var(--bo-fg)] underline-offset-2 hover:underline"
                  >
                    Dashboard
                  </Link>,
                ]}
              />
            );
          })}
        </SurfaceTable>
      )}
    </SurfacePanel>
  );
}
