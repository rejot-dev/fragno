import {
  BackofficeApiRequestError,
  BackofficeApiUnreachableError,
} from "@fragno-dev/backoffice-api/v0/client";
import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Select } from "@fragno-private/design-system/select";
import { env } from "cloudflare:workers";
import { Form, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { createProvisioningClient, isBackofficeUnavailable } from "../../workers/backoffice/client";
import type { WorkspaceMember, WorkspaceRole } from "../../workers/workspaces/workspaces";
import { assertSameOrigin } from "../auth/session.server";
import type { Route } from "./+types/members";
import {
  callBackoffice,
  canManage,
  connectAsUser,
  parseRoles,
  requireWorkspace,
} from "./access.server";
import type { WorkspaceOutletContext } from "./layout";

export function meta() {
  return [{ title: "Members · Bookkeeping" }];
}

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter an email address.")),
  role: z.enum(["member", "admin", "owner"]),
});

function workspaces() {
  return env.WORKSPACES.getByName("workspaces");
}

function invitationLink(invitationId: string): string {
  return new URL(`/invitations/${invitationId}`, env.BOOKKEEPING_BASE_URL).toString();
}

/**
 * Has Backoffice email the invitation in Bookkeeping's name. The invitation exists either way,
 * and the page shows its link, so a failure only means the inviter sends the link themselves.
 */
async function emailInvitation(invitationId: string): Promise<boolean> {
  try {
    const provisioning = await createProvisioningClient(env);
    await provisioning.call("invitations.send", {
      invitationId,
      url: invitationLink(invitationId),
    });
    return true;
  } catch (error) {
    if (
      error instanceof BackofficeApiRequestError ||
      error instanceof BackofficeApiUnreachableError ||
      isBackofficeUnavailable(error)
    ) {
      console.warn("The invitation email was not sent:", error.message);
      return false;
    }
    throw error;
  }
}

async function backofficeFor(request: Request, slug: string) {
  const context = await requireWorkspace(request, slug);
  const backoffice = await connectAsUser(request, context.membership.workspace);
  if (!backoffice) {
    throw new Response("You are no longer a member of this workspace.", { status: 404 });
  }
  return {
    ...context,
    backoffice,
    scope: { kind: "org", orgId: context.membership.workspace.id } as const,
  };
}

/** Members as Backoffice lists them now, with the names people gave Bookkeeping. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, membership, backoffice, scope } = await backofficeFor(request, params.slug);
  const listed = [];
  let cursor: string | null = null;
  do {
    const page = await callBackoffice(() =>
      backoffice.call(scope, "org.members.list", { pageSize: 100, cursor }),
    );
    listed.push(...page.members);
    cursor = page.nextCursor;
  } while (cursor !== null);
  const names = await env.AUTH.getByName("auth").findNames(listed.map(({ userId }) => userId));
  const members: WorkspaceMember[] = listed.map((member) => ({
    userId: member.userId,
    name: names[member.userId] || member.name,
    email: member.email,
    roles: parseRoles(member.roles),
  }));
  const now = Date.now();
  await workspaces().replaceMembers({ workspace: membership.workspace, members, confirmedAt: now });
  const invitations = await workspaces().listInvitations({
    workspaceId: membership.workspace.id,
    now,
  });
  return {
    you: user.backofficeUserId,
    members,
    invitations: invitations.map((invitation) => ({
      email: invitation.email,
      roles: invitation.roles,
      invitedBy: invitation.invitedBy,
      link: invitationLink(invitation.id),
    })),
    canInvite: canManage(membership.roles),
    canInviteOwners: membership.roles.includes("owner"),
  };
}

/** Invites someone in Backoffice, which allows only owners and admins to, and keeps the link. */
export async function action({ request, params }: Route.ActionArgs) {
  const { user, membership, backoffice, scope } = await backofficeFor(request, params.slug);
  assertSameOrigin(request);
  const parsed = inviteSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return {
      status: "rejected",
      message: parsed.error.issues[0]?.message ?? "Check the form.",
    } as const;
  }
  let invitation;
  try {
    invitation = await callBackoffice(() =>
      backoffice.call(scope, "org.invitations.create", {
        email: parsed.data.email,
        roles: [parsed.data.role],
      }),
    );
  } catch (error) {
    if (error instanceof BackofficeApiRequestError) {
      return { status: "rejected", message: error.message } as const;
    }
    throw error;
  }
  await workspaces().addInvitation({
    id: invitation.invitationId,
    workspaceId: membership.workspace.id,
    email: invitation.email,
    roles: parseRoles(invitation.roles),
    invitedBy: user.name || user.email,
    expiresAt: Date.parse(invitation.expiresAt),
  });
  return {
    status: "invited",
    email: invitation.email,
    link: invitationLink(invitation.invitationId),
    emailed: await emailInvitation(invitation.invitationId),
  } as const;
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

function rolesLabel(roles: WorkspaceRole[]): string {
  return roles.map((role) => ROLE_LABELS[role]).join(", ");
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const { workspace } = useOutletContext<WorkspaceOutletContext>();
  const roleOptions = (["member", "admin", "owner"] as const)
    .filter((role) => role !== "owner" || loaderData.canInviteOwners)
    .map((role) => ({ label: ROLE_LABELS[role], value: role }));
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Members"
        description="Everyone here can open this workspace's books. Owners and admins invite new people."
        breadcrumbs={[{ label: workspace.name, to: `/w/${workspace.slug}` }, { label: "Members" }]}
      />
      <div className="max-w-2xl space-y-6">
        <FormContainer title="People">
          <ul className="divide-y divide-[var(--bo-border)]">
            {loaderData.members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-3 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {member.name || member.email}
                    {member.userId === loaderData.you ? " (you)" : ""}
                  </span>
                  {member.name && (
                    <span className="block truncate text-xs text-[var(--bo-muted)]">
                      {member.email}
                    </span>
                  )}
                </span>
                <span className="text-xs text-[var(--bo-muted)]">{rolesLabel(member.roles)}</span>
              </li>
            ))}
          </ul>
        </FormContainer>
        {loaderData.canInvite && (
          <FormContainer
            title="Invite someone"
            description="We email them an invitation. They sign in with the invited email to join."
          >
            <Form method="post" className="space-y-4">
              <Field label="Email">
                <Input className="w-full" name="email" type="email" autoComplete="off" required />
              </Field>
              <Field label="Role">
                <Select name="role" options={roleOptions} defaultValue="member" required />
              </Field>
              {actionData?.status === "rejected" && (
                <p role="alert" className="text-sm text-[var(--bo-failed)]">
                  {actionData.message}
                </p>
              )}
              {actionData?.status === "invited" && (
                <div role="status" className="space-y-1 text-sm">
                  <p>
                    {actionData.emailed
                      ? `We emailed ${actionData.email} an invitation. You can also send them this link:`
                      : `We couldn't email ${actionData.email}. Send them this link:`}
                  </p>
                  <Input
                    className="w-full"
                    readOnly
                    value={actionData.link}
                    aria-label="Invitation link"
                  />
                </div>
              )}
              <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
                Create invitation
              </Button>
            </Form>
          </FormContainer>
        )}
        {loaderData.invitations.length > 0 && (
          <FormContainer title="Waiting to join">
            <ul className="divide-y divide-[var(--bo-border)]">
              {loaderData.invitations.map((invitation) => (
                <li key={invitation.link} className="space-y-1 py-3">
                  <span className="block text-sm font-medium">
                    {invitation.email} · {rolesLabel(invitation.roles)}
                  </span>
                  <span className="block truncate text-xs text-[var(--bo-muted)]">
                    Invited by {invitation.invitedBy} · {invitation.link}
                  </span>
                </li>
              ))}
            </ul>
          </FormContainer>
        )}
      </div>
    </div>
  );
}
