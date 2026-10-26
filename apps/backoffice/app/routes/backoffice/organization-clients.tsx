import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useState } from "react";
import { data, Form, Link, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organization-clients";
import { dashboardPath } from "./dashboard/path";
import type { OrganizationLayoutContext } from "./organization-layout";
import { Notice } from "./organization-shared";
import { addsClients, formatDate, formatRoles } from "./organization-utils";

export function meta() {
  return [{ title: "Organization Clients" }];
}

/** Creates a client organization this one manages, then opens its dashboard. */
export async function action({ request, context, params }: Route.ActionArgs) {
  const { me } = getBackofficeShellRequest(context);
  const membership = me.organizations.find(
    ({ organization }) => organization.slug === params.orgSlug,
  );
  if (!membership || !addsClients(membership)) {
    throw new Response("Forbidden", { status: 403 });
  }
  const input = z
    .object({ name: z.string().trim().min(1).max(100) })
    .safeParse(Object.fromEntries(await request.formData()));
  if (!input.success) {
    return data({ error: "Enter a name of at most 100 characters." }, { status: 400 });
  }
  const client = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.auth.singleton()
    .commands.createManagedOrganization({
      id: crypto.randomUUID(),
      userId: me.user.id,
      managingOrganizationId: membership.organization.id,
      name: input.data.name,
    });
  return redirect(dashboardPath({ kind: "org", orgSlug: client.slug }));
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
export default function BackofficeOrganizationClients({ actionData }: Route.ComponentProps) {
  const { organization, membership, me, relations } = useOutletContext<OrganizationLayoutContext>();
  const clients = relations.managedOrganizations;
  const rolesById = new Map(
    me.organizations.map((entry) => [entry.organization.id, entry.roles] as const),
  );
  const adding = addsClients(membership);

  return (
    <div className="space-y-4">
      {adding ? <AddClientForm error={actionData?.error ?? null} /> : null}
      <SurfacePanel
        caption={`${clients.length} ${clients.length === 1 ? "client" : "clients"}`}
        actions={null}
      >
        {clients.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title={`${organization.name} manages no organizations.`}
            description={
              adding
                ? "Add a client to run Backoffice for it. Your members act in it without being invited."
                : "Its owners and admins add clients, which its members then act in without being invited."
            }
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
    </div>
  );
}

function AddClientForm({ error }: { error: string | null }) {
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const creating = navigation.state !== "idle" && navigation.formMethod === "POST";

  return (
    <SurfacePanel caption="Add a client" actions={null}>
      <SurfacePanelBody>
        <Form method="post" className="flex max-w-2xl flex-col gap-4">
          <p className="text-sm text-pretty text-[var(--bo-muted)]">
            The client keeps its data where this organization does. You own it, and this
            organization&rsquo;s owners and admins act in it as admins.
          </p>
          <Field label="Name" required>
            <Input
              type="text"
              name="name"
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
              }}
              className="w-full"
            />
          </Field>
          <div>
            <Button variant="accent" type="submit" disabled={!name.trim() || creating}>
              {creating ? "Adding…" : "Add client"}
            </Button>
          </div>
          <Notice notice={error ? { type: "error", message: error } : null} />
        </Form>
      </SurfacePanelBody>
    </SurfacePanel>
  );
}
