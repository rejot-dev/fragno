import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useLoaderData,
  useNavigation,
  useOutletContext,
  useRevalidator,
} from "react-router";
import { z } from "zod";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { authClient } from "@/fragno/auth/auth-client";
import { loadUserInvitations } from "@/fragno/auth/auth-directory.server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { organizationSlugFromName } from "@/fragno/auth/organization-slug";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/organizations";
import { dashboardPath } from "./dashboard/path";
import { Notice } from "./organization-shared";
import {
  type ActionNotice,
  formatDate,
  formatDateTime,
  formatRoles,
  getErrorMessage,
} from "./organization-utils";
import { sortOrganizationsByPreference } from "./organizations-preference";
import { SettingsTabs } from "./settings-tabs";

export async function loader({ request, context }: Route.LoaderArgs) {
  return await loadUserInvitations({ request, context });
}

/** Creates an organization owned by the signed-in user, then opens its dashboard. */
export async function action({ request, context, url }: Route.ActionArgs) {
  const user = await requireBackofficeBrowserSession({ request, context, url });
  const input = z
    .object({ name: z.string().trim().min(1).max(100) })
    .safeParse(Object.fromEntries(await request.formData()));
  if (!input.success) {
    return data({ error: "Enter a name of at most 100 characters." }, { status: 400 });
  }
  const { runtime } = context.get(BackofficeWorkerContext);
  const organization = await runtime.objects.auth.singleton().commands.createUserOrganization({
    id: crypto.randomUUID(),
    userId: user.id,
    name: input.data.name,
  });
  return redirect(dashboardPath({ kind: "org", orgSlug: organization.slug }));
}

type UserInvitation = Extract<
  Awaited<ReturnType<typeof loader>>,
  { status: "listed" }
>["invitations"][number];

export function meta() {
  return [
    { title: "Backoffice Organizations" },
    { name: "description", content: "Manage organizations for the Fragno backoffice." },
  ];
}

export default function BackofficeOrganizations({ actionData }: Route.ComponentProps) {
  const { me: initialMe } = useOutletContext<BackofficeLayoutContext>();
  const revalidator = useRevalidator();
  const userInvitations = useLoaderData<typeof loader>();
  const { mutate: respondInvitation, loading: respondingInvitation } =
    authClient.useRespondOrganizationInvitation();
  const [invitationNotice, setInvitationNotice] = useState<ActionNotice>(null);
  const [activeInvitationId, setActiveInvitationId] = useState<string | null>(null);
  const me = initialMe;
  const organizations = me?.organizations ?? [];
  const sortedOrganizations = groupOrganizationsByAccess(
    sortOrganizationsByPreference(organizations, me.activeOrganizationId),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const showCreate = createOpen || organizations.length === 0 || Boolean(actionData?.error);
  const openInvitations =
    userInvitations.status === "listed" ? userInvitations.invitations : ([] as UserInvitation[]);

  const handleInvitationAction = async (entry: UserInvitation, action: "accept" | "reject") => {
    if (action === "reject") {
      const shouldReject = window.confirm("Reject this invitation?");
      if (!shouldReject) {
        return;
      }
    }

    setInvitationNotice(null);
    setActiveInvitationId(entry.invitation.id);
    try {
      await respondInvitation({
        path: { invitationId: entry.invitation.id },
        body: { action },
      });
      await revalidator.revalidate();
      setInvitationNotice({
        type: "success",
        message:
          action === "accept"
            ? `Invitation accepted for ${entry.organization.name}.`
            : "Invitation rejected.",
      });
    } catch (error) {
      setInvitationNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      setActiveInvitationId(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Organizations</h1>
      <SettingsTabs active="organizations" />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <SurfacePanel
          caption={`${organizations.length} ${organizations.length === 1 ? "organization" : "organizations"}`}
          actions={
            showCreate ? null : (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setCreateOpen(true);
                }}
              >
                New organization
              </Button>
            )
          }
        >
          {organizations.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="You are not a member of any organization yet."
              description="Create one below or accept an invitation."
              flush
            />
          ) : (
            <SurfaceTable columns={ORGANIZATION_COLUMNS}>
              {sortedOrganizations.map(({ organization, roles, through }) => (
                <SurfaceTableRow
                  key={organization.id}
                  columns={ORGANIZATION_COLUMNS}
                  cells={[
                    <Link
                      key="organization"
                      to={`/backoffice/organizations/${encodeURIComponent(organization.slug)}`}
                      className="group block max-w-[24rem] min-w-0"
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate font-semibold text-[var(--bo-fg)] group-hover:underline">
                          {organization.name}
                        </span>
                        {organization.id === me.activeOrganizationId ? (
                          <BackofficeStatusLight tone="live">Active</BackofficeStatusLight>
                        ) : null}
                      </span>
                      <span className="block truncate font-mono text-[11px]">
                        {organization.slug}
                      </span>
                    </Link>,
                    formatRoles(roles),
                    through.kind === "managing-organization"
                      ? `Through ${through.organization.name}`
                      : "Member",
                    <span key="created" className="whitespace-nowrap">
                      {formatDate(organization.createdAt)}
                    </span>,
                  ]}
                />
              ))}
            </SurfaceTable>
          )}
        </SurfacePanel>

        {/* Only open invitations are worth a panel; there is nothing to do without them. */}
        {openInvitations.length === 0 && !invitationNotice ? null : (
          <SurfacePanel
            caption={`${openInvitations.length} ${openInvitations.length === 1 ? "invitation" : "invitations"} for you`}
            actions={null}
          >
            {openInvitations.length === 0 ? null : (
              <SurfaceTable columns={INVITATION_COLUMNS}>
                {openInvitations.map((entry) => {
                  const isWorking =
                    respondingInvitation && activeInvitationId === entry.invitation.id;
                  return (
                    <SurfaceTableRow
                      key={entry.invitation.id}
                      columns={INVITATION_COLUMNS}
                      cells={[
                        <span key="organization" className="font-semibold text-[var(--bo-fg)]">
                          {entry.organization.name}
                        </span>,
                        formatRoles(entry.invitation.roles),
                        <span key="sent" className="whitespace-nowrap">
                          {formatDateTime(entry.invitation.createdAt)}
                        </span>,
                        <span key="expires" className="whitespace-nowrap">
                          {formatDateTime(entry.invitation.expiresAt)}
                        </span>,
                        <div key="actions" className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="accent"
                            type="button"
                            onClick={() => void handleInvitationAction(entry, "accept")}
                            disabled={respondingInvitation}
                          >
                            {isWorking ? "Accepting…" : "Accept"}
                          </Button>
                          <Button
                            variant="danger"
                            type="button"
                            onClick={() => void handleInvitationAction(entry, "reject")}
                            disabled={respondingInvitation}
                          >
                            {isWorking ? "Rejecting…" : "Reject"}
                          </Button>
                        </div>,
                      ]}
                    />
                  );
                })}
              </SurfaceTable>
            )}
            {invitationNotice ? (
              <SurfacePanelBody>
                <Notice notice={invitationNotice} />
              </SurfacePanelBody>
            ) : null}
          </SurfacePanel>
        )}

        {userInvitations.status === "email-unverified" ? (
          <p className="text-xs text-[var(--bo-muted-2)]">
            Verify your email address to see invitations sent to it.
          </p>
        ) : null}

        {showCreate ? (
          <CreateOrganizationForm
            error={actionData?.error ?? null}
            onCancel={
              organizations.length === 0
                ? null
                : () => {
                    setCreateOpen(false);
                  }
            }
          />
        ) : null}
      </div>
    </div>
  );
}

const ORGANIZATION_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Organization", align: "start" },
  { label: "Your roles", align: "start" },
  { label: "Access", align: "start" },
  { label: "Created", align: "start" },
];

/**
 * The organizations the user belongs to first, then each managing organization's clients together,
 * in the order their managers are listed, so an agency's clients read as one block.
 */
function groupOrganizationsByAccess<
  TEntry extends {
    organization: { id: string };
    through:
      | { kind: "membership" }
      | { kind: "managing-organization"; organization: { id: string } };
  },
>(entries: TEntry[]): TEntry[] {
  const memberships = entries.filter(({ through }) => through.kind === "membership");
  return [
    ...memberships,
    ...memberships.flatMap(({ organization: manager }) =>
      entries.filter(
        ({ through }) =>
          through.kind === "managing-organization" && through.organization.id === manager.id,
      ),
    ),
  ];
}

const INVITATION_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Organization", align: "start" },
  { label: "Roles", align: "start" },
  { label: "Sent", align: "start" },
  { label: "Expires", align: "start" },
  { label: "Actions", align: "end" },
];

function CreateOrganizationForm({
  error,
  onCancel,
}: {
  error: string | null;
  onCancel: (() => void) | null;
}) {
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const creating = navigation.state !== "idle" && navigation.formMethod === "POST";

  return (
    <SurfacePanel caption="Create an organization" actions={null}>
      <SurfacePanelBody>
        <Form method="post" className="flex max-w-2xl flex-col gap-4">
          <p className="text-sm text-pretty text-[var(--bo-muted)]">
            Organizations share projects, automations, and integrations with their members. You
            become its owner.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                type="text"
                name="name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                className="w-full"
              />
            </Field>
            {/* Auth chooses the slug and appends a number when another organization has it. */}
            <Field label="Slug">
              <Input
                type="text"
                value={name.trim() ? organizationSlugFromName(name) : ""}
                disabled
                className="w-full"
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" type="submit" disabled={!name.trim() || creating}>
              {creating ? "Creating…" : "Create organization"}
            </Button>
            {onCancel ? (
              <Button variant="secondary" type="button" onClick={onCancel} disabled={creating}>
                Cancel
              </Button>
            ) : null}
          </div>
          <Notice notice={error ? { type: "error", message: error } : null} />
        </Form>
      </SurfacePanelBody>
    </SurfacePanel>
  );
}
