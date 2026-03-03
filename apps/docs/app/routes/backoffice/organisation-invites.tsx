import { useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router";
import { FormContainer, FormField } from "@/components/backoffice";
import { authClient } from "@/fragno/auth-client";
import type { OrganisationLayoutContext } from "./organisation-layout";
import {
  Notice,
  ROLE_OPTIONS,
  type ActionNotice,
  formatDateTime,
  formatRoles,
  getErrorMessage,
} from "./organisation-shared";
import { cn } from "@/lib/utils";

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
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
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

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoles, setInviteRoles] = useState<string[]>(["member"]);
  const [inviteNotice, setInviteNotice] = useState<ActionNotice>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteId, setInviteId] = useState<string | null>(null);

  useEffect(() => {
    setInviteEmail("");
    setInviteRoles(["member"]);
    setInviteNotice(null);
    setInviteToken(null);
    setInviteId(null);
  }, [organization.id]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  const handleInviteSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteNotice(null);
    setInviteToken(null);
    setInviteId(null);

    const email = inviteEmail.trim();
    if (!email) {
      setInviteNotice({ type: "error", message: "Invite email is required." });
      return;
    }

    const roles = inviteRoles.length > 0 ? inviteRoles : undefined;

    try {
      const response = await inviteMember({
        path: { organizationId: organization.id },
        body: { email, roles },
      });
      setInviteNotice({ type: "success", message: `Invitation created for ${email}.` });
      if (response && typeof response === "object" && "invitation" in response) {
        const invitation = (response as { invitation?: { id?: string; token?: string } })
          .invitation;
        if (invitation?.token && invitation?.id) {
          setInviteToken(invitation.token);
          setInviteId(invitation.id);
        }
      }
      setInviteEmail("");
      setInviteRoles(["member"]);
    } catch (error) {
      setInviteNotice({ type: "error", message: getErrorMessage(error) });
    }
  };

  const toggleRole = (role: string) => {
    if (!canManageMembers) {
      return;
    }
    setInviteRoles((prev) =>
      prev.includes(role) ? prev.filter((entry) => entry !== role) : [...prev, role],
    );
  };

  const invitations = invitationsData?.invitations ?? [];
  const inviteLink =
    inviteToken && inviteId
      ? `${origin || ""}/backoffice/invitations/${inviteId}?token=${inviteToken}`
      : null;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Invitations"
        title="Invite a member"
        description="Create a shareable invitation link and assign default roles. Invitations are not emailed automatically."
      >
        <form onSubmit={handleInviteSubmit} className="space-y-3">
          <FormField
            label="Email"
            hint="Invites are not emailed automatically. Share the generated link manually or via your own hook."
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => {
                setInviteEmail(event.target.value);
                setInviteNotice(null);
              }}
              placeholder="teammate@fragno.dev"
              disabled={!canManageMembers}
              className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2 disabled:opacity-60"
            />
          </FormField>
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              Roles
            </p>
            <div className="flex flex-wrap gap-2">
              {ROLE_OPTIONS.map((role) => {
                const isSelected = inviteRoles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleRole(role)}
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
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
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
          <Notice notice={inviteNotice} />
          {inviteLink ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
              <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                Invite link
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  readOnly
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
                <tr className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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
                        <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
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
