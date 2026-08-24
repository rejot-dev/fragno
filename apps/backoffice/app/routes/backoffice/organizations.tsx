import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext, useRevalidator } from "react-router";

import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { buildBackofficeOrganizationSwitchPath } from "@/routes/backoffice/auth-navigation";

import { Notice } from "./organization-shared";
import {
  type ActionNotice,
  formatDate,
  formatDateTime,
  formatRoles,
  getErrorMessage,
} from "./organization-utils";
import {
  getOrganizationPreferenceState,
  sortOrganizationsByPreference,
} from "./organizations-preference";

type UserInvitationsHook = ReturnType<typeof authClient.useUserInvitations>;
type UserInvitation = NonNullable<UserInvitationsHook["data"]>["invitations"][number];

export function meta() {
  return [
    { title: "Backoffice Organizations" },
    { name: "description", content: "Manage organizations for the Fragno backoffice." },
  ];
}

export default function BackofficeOrganizations() {
  const { me: initialMe } = useOutletContext<BackofficeLayoutContext>();
  const preference = authClient.usePreferredOrganizationPreference();
  const { mutate: switchOrganization, loading: switchingOrganization } =
    authClient.useSwitchOrganization();
  const revalidator = useRevalidator();
  const initialPreference = useMemo(() => {
    if (!initialMe) {
      return null;
    }

    try {
      return authClient.preferredOrganization.resolve(
        initialMe,
        authClient.preferredOrganization.read(),
      );
    } catch {
      return null;
    }
  }, [initialMe]);
  const {
    data: userInvitationsData,
    loading: userInvitationsLoading,
    error: userInvitationsError,
  } = authClient.useUserInvitations();
  const { mutate: respondInvitation, loading: respondingInvitation } =
    authClient.useRespondOrganizationInvitation();
  const [invitationNotice, setInvitationNotice] = useState<ActionNotice>(null);
  const [preferredOrganizationNotice, setPreferredOrganizationNotice] =
    useState<ActionNotice>(null);
  const [activeInvitationId, setActiveInvitationId] = useState<string | null>(null);
  const [clientPreferencesReady, setClientPreferencesReady] = useState(false);
  useEffect(() => {
    setClientPreferencesReady(true);
  }, []);
  const me = initialMe;
  const organizations = me?.organizations ?? [];
  const preferredOrganizationId = clientPreferencesReady
    ? (preference.preferredOrganizationId ??
      preference.storedOrganizationId ??
      initialPreference?.resolvedOrganizationId ??
      me.activeOrganizationId)
    : me.activeOrganizationId;
  const openInvitations = userInvitationsData?.invitations ?? [];
  const sortedOrganizations = sortOrganizationsByPreference(organizations, preferredOrganizationId);

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
        body: { action, token: entry.invitation.token },
      });
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

  const handleSetPreferredOrganization = async (
    organizationId: string,
    organizationName: string,
  ) => {
    setPreferredOrganizationNotice(null);

    try {
      if (!me) {
        throw new Error("Cannot switch organizations without an authenticated user.");
      }

      await switchOrganization({ body: { organizationId } });
      await revalidator.revalidate();
      setPreferredOrganizationNotice({
        type: "success",
        message: `${organizationName} is now the active and preferred organization for the docs backoffice.`,
      });
    } catch (error) {
      setPreferredOrganizationNotice({ type: "error", message: getErrorMessage(error) });
    }
  };

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Organizations" }]}
        eyebrow="Directory"
        title="Organization rosters and access levels."
        description="Select an organization to manage settings, members, invitations, and the preferred Backoffice scope."
      />

      <FormContainer
        eyebrow="Invitations"
        title={`Open invitations (${openInvitations.length})`}
        description="Invitations addressed to your account. Accepting adds you to the organization."
      >
        {userInvitationsLoading ? (
          <p className="text-sm text-[var(--bo-muted)]">Loading invitations...</p>
        ) : userInvitationsError ? (
          <p className="text-sm text-red-600">{getErrorMessage(userInvitationsError)}</p>
        ) : openInvitations.length === 0 ? (
          <p className="text-sm text-[var(--bo-muted)]">No open invitations.</p>
        ) : (
          <div className="overflow-hidden border border-[color:var(--bo-border)]">
            <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
              <thead className="bg-[var(--bo-panel-2)] text-left">
                <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  <th scope="col" className="px-3 py-2">
                    Organization
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Roles
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Sent
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Expires
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                {openInvitations.map((entry) => {
                  const isWorking =
                    respondingInvitation && activeInvitationId === entry.invitation.id;
                  return (
                    <tr key={entry.invitation.id} className="text-[var(--bo-muted)]">
                      <td className="px-3 py-2 font-semibold text-[var(--bo-fg)]">
                        {entry.organization.name}
                      </td>
                      <td className="px-3 py-2">{formatRoles(entry.invitation.roles)}</td>
                      <td className="px-3 py-2">{formatDateTime(entry.invitation.createdAt)}</td>
                      <td className="px-3 py-2">{formatDateTime(entry.invitation.expiresAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleInvitationAction(entry, "accept")}
                            disabled={respondingInvitation}
                            className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
                          >
                            {isWorking ? "Accepting..." : "Accept"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleInvitationAction(entry, "reject")}
                            disabled={respondingInvitation}
                            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
                          >
                            {isWorking ? "Rejecting..." : "Reject"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Notice notice={invitationNotice} />
      </FormContainer>

      {organizations.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No organizations found for this account yet.
        </div>
      ) : (
        <section className="grid gap-3 md:grid-cols-2">
          {sortedOrganizations.map(({ organization, member }) => {
            const preferenceState = getOrganizationPreferenceState(
              organization.id,
              preferredOrganizationId,
            );
            return (
              <div
                key={organization.id}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      {organization.slug}
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                      {organization.name}
                    </h2>
                  </div>
                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                    {preferenceState.badgeLabel}
                  </span>
                </div>
                <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
                  <p className="flex items-center justify-between">
                    <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Roles
                    </span>
                    <span className="font-semibold text-[var(--bo-fg)]">
                      {formatRoles(member.roles)}
                    </span>
                  </p>
                  <p className="flex items-center justify-between">
                    <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Created
                    </span>
                    <span>{formatDate(organization.createdAt)}</span>
                  </p>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {preferenceState.canSwitch ? (
                    <button
                      type="button"
                      onClick={() =>
                        void handleSetPreferredOrganization(organization.id, organization.name)
                      }
                      disabled={switchingOrganization}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      {switchingOrganization ? "Updating..." : preferenceState.actionLabel}
                    </button>
                  ) : (
                    <span className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase">
                      {preferenceState.actionLabel}
                    </span>
                  )}
                  <Link
                    to={
                      organization.id === me.activeOrganizationId
                        ? `/backoffice/organizations/${encodeURIComponent(organization.slug)}`
                        : buildBackofficeOrganizationSwitchPath(
                            organization.id,
                            `/backoffice/organizations/${encodeURIComponent(organization.slug)}`,
                          )
                    }
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Open
                  </Link>
                </div>
              </div>
            );
          })}
        </section>
      )}
      <Notice notice={preferredOrganizationNotice} />
    </div>
  );
}
