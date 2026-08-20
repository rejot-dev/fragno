import { useEffect, useReducer, useState, type SubmitEvent } from "react";
import { useOutletContext } from "react-router";

import { FormContainer, FormField } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";
import { cn } from "@/lib/utils";

import type { OrganisationLayoutContext } from "./organisation-layout";
import { Notice } from "./organisation-shared";
import {
  ROLE_OPTIONS,
  type ActionNotice,
  formatDateTime,
  formatRoles,
  getErrorMessage,
} from "./organisation-utils";

type InvitationFormState = {
  email: string;
  roles: Array<(typeof ROLE_OPTIONS)[number]>;
  notice: ActionNotice;
  token: string | null;
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
      token: string | null;
      invitationId: string | null;
    };

const initialInvitationFormState: InvitationFormState = {
  email: "",
  roles: ["member"],
  notice: null,
  token: null,
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
      return { ...state, notice: null, token: null, invitationId: null };
    case "submissionRejected":
      return { ...state, notice: { type: "error", message: action.message } };
    case "submissionSucceeded":
      return {
        email: "",
        roles: ["member"],
        notice: { type: "success", message: `Invitation created for ${action.email}.` },
        token: action.token,
        invitationId: action.invitationId,
      };
    default: {
      const unreachableAction: never = action;
      return unreachableAction;
    }
  }
}

function CopyButton({
  text,
  label = "Copy link",
  disabled = false,
}: {
  text: string;
  label?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text || disabled) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={disabled}
      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function meta() {
  return [{ title: "Organisation Invites" }];
}

export default function BackofficeOrganisationInvites() {
  const { organization, member, me } = useOutletContext<OrganisationLayoutContext>();
  const canManageMembers =
    me.user.role === "admin" || member.roles.some((role) => role === "owner" || role === "admin");

  const [origin, setOrigin] = useState("");
  const {
    data: invitationsData,
    loading: invitationsLoading,
    error: invitationsError,
  } = authClient.useOrganizationInvitations({
    path: { organizationId: organization.id },
  });

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
      const invitation =
        response && typeof response === "object" && "invitation" in response
          ? (response as { invitation?: { id?: string; token?: string } }).invitation
          : undefined;
      dispatchInviteForm({
        type: "submissionSucceeded",
        email,
        token: invitation?.token ?? null,
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
  const inviteLink =
    inviteForm.token && inviteForm.invitationId
      ? `${origin || ""}/backoffice/invitations/${inviteForm.invitationId}?token=${inviteForm.token}`
      : null;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Invitations"
        title="Invite a member"
        description="Create a shareable invitation link and assign default roles. Invitations are not emailed automatically."
      >
        <form onSubmit={(event) => void handleInviteSubmit(event)} className="space-y-3">
          <FormField
            label="Email"
            hint="Invites are not emailed automatically. Share the generated link manually or via your own hook."
          >
            <input
              type="email"
              value={inviteForm.email}
              onChange={(event) => {
                dispatchInviteForm({ type: "emailChanged", email: event.target.value });
              }}
              placeholder="teammate@fragno.dev"
              disabled={!canManageMembers}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none disabled:opacity-60"
            />
          </FormField>
          <div className="space-y-2">
            <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Roles
            </p>
            <div className="flex flex-wrap gap-2">
              {ROLE_OPTIONS.map((role) => {
                const isSelected = inviteForm.roles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => {
                      toggleRole(role);
                    }}
                    disabled={!canManageMembers}
                    className={cn(
                      "border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] transition-colors",
                      isSelected
                        ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                        : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]",
                      !canManageMembers && "opacity-60",
                    )}
                  >
                    {role}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!canManageMembers || invitingMember}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
            >
              {invitingMember ? "Sending..." : "Send invite"}
            </button>
            {inviteMemberError ? (
              <span className="text-xs text-red-600">{getErrorMessage(inviteMemberError)}</span>
            ) : null}
            {!canManageMembers ? (
              <span className="text-xs text-[var(--bo-muted-2)]">
                Admin or owner access required.
              </span>
            ) : null}
          </div>
          <Notice notice={inviteForm.notice} />
          {inviteLink ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Invite link
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  readOnly
                  aria-label="Invitation link"
                  value={inviteLink}
                  className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 font-mono text-[11px] text-[var(--bo-fg)]"
                />
                <CopyButton text={inviteLink} />
              </div>
            </div>
          ) : null}
        </form>
      </FormContainer>

      <FormContainer
        eyebrow="Pending"
        title={`Open invitations (${invitations.length})`}
        description="Track pending invitations for this organisation and copy invite links to share."
      >
        {invitationsLoading ? (
          <p className="text-sm text-[var(--bo-muted)]">Loading invitations...</p>
        ) : invitationsError ? (
          <p className="text-sm text-red-600">{getErrorMessage(invitationsError)}</p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-[var(--bo-muted)]">No pending invitations.</p>
        ) : (
          <div className="overflow-hidden border border-[color:var(--bo-border)]">
            <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
              <thead className="bg-[var(--bo-panel-2)] text-left">
                <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  <th scope="col" className="px-3 py-2">
                    Email
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Roles
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Sent
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Invite link
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                {invitations.map((invitation) => {
                  const link = `${origin || ""}/backoffice/invitations/${invitation.id}?token=${invitation.token}`;
                  return (
                    <tr key={invitation.id} className="text-[var(--bo-muted)]">
                      <td className="px-3 py-2 font-semibold text-[var(--bo-fg)]">
                        {invitation.email}
                      </td>
                      <td className="px-3 py-2">{formatRoles(invitation.roles)}</td>
                      <td className="px-3 py-2">
                        <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                          {invitation.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">{formatDateTime(invitation.createdAt)}</td>
                      <td className="px-3 py-2">
                        <CopyButton text={link} disabled={!canManageMembers} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </FormContainer>
    </div>
  );
}
