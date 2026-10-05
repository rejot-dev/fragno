import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import type { Invitation } from "better-auth/plugins/organization";
import { useState } from "react";
import { useLoaderData } from "react-router";

import { authClient } from "@/fragno/auth/auth-client";
import { callBetterAuth } from "@/fragno/auth/auth-server";
import { buildBackofficeOrganizationSwitchPath } from "@/routes/backoffice/auth-navigation";

import type { Route } from "./+types/invitation-accept";
import { Notice } from "./organization-shared";
import { type ActionNotice, getErrorMessage } from "./organization-utils";

export function meta() {
  return [{ title: "Accept Invitation" }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const response = await callBetterAuth(
    request,
    context,
    `/organization/get-invitation?${new URLSearchParams({ id: params.invitationId })}`,
  );
  if (!response.ok) {
    throw response;
  }
  const invitation = (await response.json()) as Invitation & {
    organizationName: string;
    organizationSlug: string;
  };
  return {
    invitation,
    organization: {
      id: invitation.organizationId,
      name: invitation.organizationName,
      slug: invitation.organizationSlug,
    },
  };
}

export default function BackofficeInvitationAccept() {
  const { invitation, organization } = useLoaderData<typeof loader>();
  const { mutate: respondInvitation, loading } = authClient.useRespondOrganizationInvitation();
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState<ActionNotice>(null);

  async function acceptInvitation() {
    setNotice(null);
    try {
      await respondInvitation({
        path: { invitationId: invitation.id },
        body: { action: "accept" },
      });
      setAccepted(true);
      setNotice({ type: "success", message: "Invitation accepted." });
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error) });
    }
  }

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
        description={`Join ${organization.name} with your signed-in account.`}
      />
      <FormContainer
        eyebrow="Invitation"
        title="Invite status"
        description="Opening this link does not change your membership. Confirm below to join."
      >
        <Notice notice={notice} />
        {accepted ? (
          <div className="flex flex-wrap gap-2">
            <ButtonLink
              variant="accent"
              to={buildBackofficeOrganizationSwitchPath(
                organization.id,
                `/backoffice/organizations/${encodeURIComponent(organization.slug)}`,
              )}
            >
              Open organization
            </ButtonLink>
            <ButtonLink variant="secondary" to="/backoffice/organizations">
              Back to organizations
            </ButtonLink>
          </div>
        ) : (
          <Button variant="accent" disabled={loading} onClick={() => void acceptInvitation()}>
            {loading ? "Accepting invitation..." : "Accept invitation"}
          </Button>
        )}
      </FormContainer>
    </div>
  );
}
