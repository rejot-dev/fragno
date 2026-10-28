import { Button } from "@fragno-private/design-system/button";
import { Checkbox } from "@fragno-private/design-system/checkbox";
import { CopyButton } from "@fragno-private/design-system/copy-button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { usePostHog } from "@posthog/react/slim";
import { useEffect, useReducer, useState, type SubmitEvent } from "react";
import { useLoaderData, useOutletContext, useRevalidator } from "react-router";

import { authClient } from "@/fragno/auth/auth-client";
import { loadOrganizationInvitations } from "@/fragno/auth/auth-directory.server";

import type { Route } from "./+types/organization-invites";
import { backofficeInvitationPath } from "./auth-navigation";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return await loadOrganizationInvitations({ request, context }, params.orgSlug);
}

import type { OrganizationLayoutContext } from "./organization-layout";
import { Notice } from "./organization-shared";
import {
  ROLE_OPTIONS,
  type ActionNotice,
  formatDateTime,
  formatRoles,
  getErrorMessage,
} from "./organization-utils";

type InvitationFormState = {
  email: string;
  roles: Array<(typeof ROLE_OPTIONS)[number]>;
  notice: ActionNotice;
  invitationId: string | null;
};

type InvitationFormAction =
  | { type: "reset" }
  | { type: "emailChanged"; email: string }
  | { type: "roleToggled"; role: (typeof ROLE_OPTIONS)[number] }
  | { type: "submissionStarted" }
  | { type: "submissionRejected"; message: string }
  | {
      type: "submissionSucceeded";
      email: string;
      invitationId: string | null;
    };

const initialInvitationFormState: InvitationFormState = {
  email: "",
  roles: ["member"],
  notice: null,
  invitationId: null,
};

function invitationFormReducer(
  state: InvitationFormState,
  action: InvitationFormAction,
): InvitationFormState {
  switch (action.type) {
    case "reset":
      return initialInvitationFormState;
    case "emailChanged":
      return { ...state, email: action.email, notice: null };
    case "roleToggled":
      return {
        ...state,
        roles: state.roles.includes(action.role)
          ? state.roles.filter((role) => role !== action.role)
          : [...state.roles, action.role],
      };
    case "submissionStarted":
      return { ...state, notice: null, invitationId: null };
    case "submissionRejected":
      return { ...state, notice: { type: "error", message: action.message } };
    case "submissionSucceeded":
      return {
        email: "",
        roles: ["member"],
        notice: { type: "success", message: `Invitation created for ${action.email}.` },
        invitationId: action.invitationId,
      };
    default: {
      const unreachableAction: never = action;
      return unreachableAction;
    }
  }
}

export function meta() {
  return [{ title: "Organization Invites" }];
}

export default function BackofficeOrganizationInvites() {
  const posthog = usePostHog();
  const { organization, membership, me } = useOutletContext<OrganizationLayoutContext>();
  const canManageMembers =
    me.user.role === "admin" ||
    membership.roles.some((role) => role === "owner" || role === "admin");

  const [origin, setOrigin] = useState("");
  const invitationsData = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const {
    mutate: inviteMember,
    loading: invitingMember,
    error: inviteMemberError,
  } = authClient.useInviteOrganizationMember();

  const [inviteForm, dispatchInviteForm] = useReducer(
    invitationFormReducer,
    initialInvitationFormState,
  );

  useEffect(() => {
    dispatchInviteForm({ type: "reset" });
  }, [organization.id]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  const handleInviteSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    dispatchInviteForm({ type: "submissionStarted" });

    const email = inviteForm.email.trim();
    if (!email) {
      dispatchInviteForm({ type: "submissionRejected", message: "Invite email is required." });
      return;
    }

    const roles = inviteForm.roles.length > 0 ? inviteForm.roles : undefined;

    try {
      const response = await inviteMember({
        path: { organizationId: organization.id },
        body: { email, roles },
      });
      const invitation = response.invitation;
      await revalidator.revalidate();
      if (posthog) {
        posthog.capture("organization_invitation_sent", {
          organization_id: organization.id,
          role_count: roles?.length ?? 0,
        });
      }
      dispatchInviteForm({
        type: "submissionSucceeded",
        email,
        invitationId: invitation?.id ?? null,
      });
    } catch (error) {
      dispatchInviteForm({ type: "submissionRejected", message: getErrorMessage(error) });
    }
  };

  const toggleRole = (role: (typeof ROLE_OPTIONS)[number]) => {
    if (!canManageMembers) {
      return;
    }
    dispatchInviteForm({ type: "roleToggled", role });
  };

  const invitations = invitationsData?.invitations ?? [];
  const inviteLink = inviteForm.invitationId
    ? `${origin}${backofficeInvitationPath(inviteForm.invitationId)}`
    : null;

  return (
    <>
      <SurfacePanel caption="Invite a member" actions={null}>
        <SurfacePanelBody>
          <form
            onSubmit={(event) => void handleInviteSubmit(event)}
            className="flex max-w-xl flex-col gap-4"
          >
            <Field
              label="Email"
              description="Invitations are not emailed. Share the generated link with your teammate."
            >
              <Input
                type="email"
                value={inviteForm.email}
                onChange={(event) => {
                  dispatchInviteForm({ type: "emailChanged", email: event.target.value });
                }}
                placeholder="teammate@fragno.dev"
                disabled={!canManageMembers}
                className="w-full"
              />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-semibold text-[var(--bo-fg)]">Roles</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {ROLE_OPTIONS.map((role) => (
                  <Checkbox
                    key={role}
                    checked={inviteForm.roles.includes(role)}
                    onCheckedChange={() => {
                      toggleRole(role);
                    }}
                    disabled={!canManageMembers}
                  >
                    {role}
                  </Checkbox>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent" type="submit" disabled={!canManageMembers || invitingMember}>
                {invitingMember ? "Creating…" : "Create invitation"}
              </Button>
              {!canManageMembers ? (
                <span className="text-xs text-[var(--bo-muted-2)]">
                  Admin or owner access required.
                </span>
              ) : null}
            </div>
            {inviteMemberError && !inviteForm.notice ? (
              <Notice notice={{ type: "error", message: getErrorMessage(inviteMemberError) }} />
            ) : (
              <Notice notice={inviteForm.notice} />
            )}
            {inviteLink ? (
              <Field label="Invitation link">
                <div className="flex items-center gap-2">
                  <Input readOnly value={inviteLink} className="w-full font-mono text-xs" />
                  <CopyButton value={inviteLink} label="Copy link" text="Copy link" />
                </div>
              </Field>
            ) : null}
          </form>
        </SurfacePanelBody>
      </SurfacePanel>

      <SurfacePanel
        caption={`${invitations.length} ${invitations.length === 1 ? "invitation" : "invitations"}`}
        actions={null}
      >
        {invitations.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title="No invitations yet."
            description="Invitations you create appear here with a link to share."
            flush
          />
        ) : (
          <SurfaceTable columns={INVITATION_COLUMNS}>
            {invitations.map((invitation) => (
              <SurfaceTableRow
                key={invitation.id}
                columns={INVITATION_COLUMNS}
                cells={[
                  <span key="email" className="font-semibold text-[var(--bo-fg)]">
                    {invitation.email}
                  </span>,
                  formatRoles(invitation.roles),
                  <BackofficeStatusLight
                    key="status"
                    tone={invitationStatusTone(invitation.status)}
                  >
                    {invitation.status}
                  </BackofficeStatusLight>,
                  <span key="sent" className="whitespace-nowrap">
                    {formatDateTime(invitation.createdAt)}
                  </span>,
                  invitation.status === "pending" && canManageMembers ? (
                    <CopyButton
                      key="link"
                      value={`${origin}${backofficeInvitationPath(invitation.id)}`}
                      label="Copy link"
                      text="Copy link"
                    />
                  ) : (
                    "—"
                  ),
                ]}
              />
            ))}
          </SurfaceTable>
        )}
      </SurfacePanel>
    </>
  );
}

const INVITATION_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Email", align: "start" },
  { label: "Roles", align: "start" },
  { label: "Status", align: "start" },
  { label: "Sent", align: "start" },
  { label: "Link", align: "start" },
];

function invitationStatusTone(status: string): BackofficeStatusTone {
  if (status === "pending") {
    return "waiting";
  }
  return status === "accepted" ? "live" : "muted";
}
