import { FragnoClientApiError } from "@fragno-dev/core/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import {
  backofficeOrganizationIdentity,
  type BackofficeOrganizationIdentity,
} from "@/backoffice-runtime/resolved-scope";
import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";
import { buildBackofficeOrganizationSwitchPath } from "@/routes/backoffice/auth-navigation";

import { Notice } from "./organization-shared";
import { type ActionNotice, getErrorMessage } from "./organization-utils";

export function meta() {
  return [{ title: "Accept Invitation" }];
}

const INVITATION_ERROR_COPY: Record<string, string> = {
  invitation_not_found:
    "This invitation was not found for your account. Make sure you are signed in as the invited user.",
  invalid_token: "The invitation link is invalid or incomplete. Ask an admin to send a new one.",
  invitation_expired: "This invitation has expired. Ask an admin to send a new invitation.",
  permission_denied: "You do not have permission to accept this invitation with this account.",
  session_invalid: "Your session expired. Please sign in again.",
  limit_reached:
    "This organization has reached its member limit. Ask an admin to increase the limit.",
};

const getInvitationErrorMessage = (error: unknown) => {
  if (error instanceof FragnoClientApiError) {
    const message = INVITATION_ERROR_COPY[error.code];
    if (message) {
      return message;
    }
  }
  if (typeof error === "object" && error && "code" in error) {
    const code = String((error as { code?: string }).code);
    const message = INVITATION_ERROR_COPY[code];
    if (message) {
      return message;
    }
  }
  return getErrorMessage(error);
};

export default function BackofficeInvitationAccept() {
  const { invitationId } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { mutate: respondInvitation, loading: respondingInvitation } =
    authClient.useRespondOrganizationInvitation();
  const {
    data: userInvitationsData,
    loading: userInvitationsLoading,
    error: userInvitationsError,
  } = authClient.useUserInvitations();
  const [notice, setNotice] = useState<ActionNotice>(null);
  const [status, setStatus] = useState<"idle" | "checking" | "accepting" | "success" | "error">(
    "idle",
  );
  const [acceptedOrganization, setAcceptedOrganization] =
    useState<BackofficeOrganizationIdentity | null>(null);
  const respondInvitationRef = useRef(respondInvitation);
  const acceptanceRequestKey = useRef<string | null>(null);

  useEffect(() => {
    respondInvitationRef.current = respondInvitation;
  }, [respondInvitation]);

  const invitationEntry = useMemo(() => {
    if (!invitationId) {
      return null;
    }
    return (
      userInvitationsData?.invitations.find((entry) => entry.invitation.id === invitationId) ?? null
    );
  }, [invitationId, userInvitationsData?.invitations]);

  useEffect(() => {
    if (!invitationId) {
      setStatus("error");
      setNotice({ type: "error", message: "Invitation ID is missing." });
      return undefined;
    }
    if (!token) {
      setStatus("error");
      setNotice({ type: "error", message: "Invite token is missing." });
      return undefined;
    }

    const requestKey = `${invitationId}:${token}`;
    if (acceptanceRequestKey.current === requestKey) {
      return undefined;
    }

    if (userInvitationsLoading) {
      setStatus("checking");
      return undefined;
    }

    if (userInvitationsError) {
      setStatus("error");
      setNotice({ type: "error", message: getInvitationErrorMessage(userInvitationsError) });
      return undefined;
    }

    if (!invitationEntry) {
      setStatus("error");
      setNotice({
        type: "error",
        message:
          "This invitation is not available for your account. Make sure you are signed in as the invited user.",
      });
      return undefined;
    }

    if (invitationEntry.invitation.token !== token) {
      setStatus("error");
      setNotice({
        type: "error",
        message: "The invitation token does not match. Please request a new link.",
      });
      return undefined;
    }

    acceptanceRequestKey.current = requestKey;
    let active = true;
    setStatus("accepting");
    setNotice(null);

    void respondInvitationRef
      .current({
        path: { invitationId },
        body: { action: "accept", token },
      })
      .then(
        (response) => {
          if (!active) {
            return;
          }
          const invitation =
            response && typeof response === "object" && "invitation" in response
              ? (response as { invitation?: { organizationId?: string } }).invitation
              : null;
          if (invitation?.organizationId !== invitationEntry.organization.id) {
            setStatus("error");
            setNotice({
              type: "error",
              message: "The accepted invitation returned an unexpected organization.",
            });
            return;
          }
          setAcceptedOrganization(backofficeOrganizationIdentity(invitationEntry.organization));
          setStatus("success");
          setNotice({ type: "success", message: "Invitation accepted." });
        },
        (error: unknown) => {
          if (!active) {
            return;
          }
          setStatus("error");
          setNotice({ type: "error", message: getInvitationErrorMessage(error) });
        },
      );

    return () => {
      active = false;
    };
  }, [invitationEntry, invitationId, token, userInvitationsError, userInvitationsLoading]);

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Organizations", to: "/backoffice/organizations" },
          { label: "Accept invitation" },
        ]}
        eyebrow="Invitations"
        title="Accept invitation"
        description="This link automatically accepts the invitation for your account."
      />

      <FormContainer
        eyebrow="Invitation"
        title="Invite status"
        description="If something looks wrong, confirm that the URL includes both the invitation ID and token."
      >
        {status === "checking" ? (
          <p className="text-sm text-[var(--bo-muted)]">Checking invitation...</p>
        ) : null}
        {status === "accepting" || respondingInvitation ? (
          <p className="text-sm text-[var(--bo-muted)]">Accepting invitation...</p>
        ) : null}
        <Notice notice={notice} />
        {status === "success" && acceptedOrganization ? (
          <div className="flex flex-wrap gap-2">
            <Link
              to={buildBackofficeOrganizationSwitchPath(
                acceptedOrganization.id,
                `/backoffice/organizations/${encodeURIComponent(acceptedOrganization.slug)}`,
              )}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              Open organization
            </Link>
            <Link
              to="/backoffice/organizations"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Back to organizations
            </Link>
          </div>
        ) : null}
      </FormContainer>
    </div>
  );
}
