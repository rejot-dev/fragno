import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import { Button } from "@fragno-private/design-system/button";
import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";

import { createProvisioningClient } from "../../workers/backoffice/client";
import { assertSameOrigin, getSessionUser, requireSessionUser } from "../auth/session.server";
import { SignInButton } from "../auth/sign-in-button";
import { callBackoffice } from "../workspace/access.server";
import type { Route } from "./+types/invitation";

export function meta() {
  return [{ title: "Invitation · Bookkeeping" }];
}

function workspaces() {
  return env.WORKSPACES.getByName("workspaces");
}

async function findOpenInvitation(invitationId: string) {
  const invitation = await workspaces().findInvitation(invitationId);
  return invitation && invitation.expiresAt > Date.now() ? invitation : null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const invitation = await findOpenInvitation(params.invitationId);
  if (!invitation) {
    return { status: "invalid" } as const;
  }
  const user = await getSessionUser(request);
  return {
    status: "open",
    workspaceName: invitation.workspace.name,
    invitedBy: invitation.invitedBy,
    email: invitation.email,
    signedInAs: user?.email ?? null,
  } as const;
}

/** Joins the workspace in Backoffice, which checks that the invitation is for this person. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireSessionUser(request);
  assertSameOrigin(request);
  const invitation = await findOpenInvitation(params.invitationId);
  if (!invitation) {
    return { error: "This invitation is no longer valid." };
  }
  let membership;
  try {
    membership = await callBackoffice(async () =>
      (await createProvisioningClient(env)).call("invitations.accept", {
        invitationId: invitation.id,
        userId: user.backofficeUserId,
      }),
    );
  } catch (error) {
    if (!(error instanceof BackofficeApiRequestError)) {
      throw error;
    }
    if (error.code === "forbidden") {
      return {
        error: `This invitation is for ${invitation.email}, but you're signed in as ${user.email}.`,
      };
    }
    if (error.code === "conflict" || error.code === "not_found") {
      await workspaces().removeInvitation(invitation.id);
      return { error: "This invitation is no longer valid." };
    }
    throw error;
  }
  await workspaces().removeInvitation(invitation.id);
  // The workspace confirms the new membership with Backoffice as it opens.
  throw redirect(`/w/${membership.organization.slug}`);
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function Invitation({ loaderData, actionData, params }: Route.ComponentProps) {
  const navigation = useNavigation();
  if (loaderData.status === "invalid") {
    return (
      <section className="auth">
        <h1>This invitation is no longer valid</h1>
        <p>
          It may have expired or already been used. Ask the person who invited you to send a new
          one.
        </p>
        <p>
          <Link to="/">Go to Bookkeeping</Link>
        </p>
      </section>
    );
  }
  return (
    <section className="auth">
      <h1>Join {loaderData.workspaceName}</h1>
      <p>
        {loaderData.invitedBy} invited {loaderData.email} to keep the books of{" "}
        {loaderData.workspaceName} together in Bookkeeping.
      </p>
      {loaderData.signedInAs === null ? (
        <SignInButton returnTo={`/invitations/${params.invitationId}`} />
      ) : (
        <Form method="post" className="space-y-3">
          <Button
            type="submit"
            variant="solid"
            className="w-full"
            disabled={navigation.state !== "idle"}
          >
            Join {loaderData.workspaceName}
          </Button>
          <p className="text-sm">You're signed in as {loaderData.signedInAs}.</p>
        </Form>
      )}
      {actionData?.error && (
        <p role="alert" className="error">
          {actionData.error}
        </p>
      )}
    </section>
  );
}
