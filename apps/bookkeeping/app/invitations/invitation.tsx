import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import { Button } from "@fragno-private/design-system/button";
import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";

import { createProvisioningClient } from "../../workers/backoffice/client";
import type { Invitation } from "../../workers/directory/directory";
import {
  assertSameOrigin,
  getSessionUser,
  requireName,
  requireSessionUser,
} from "../auth/session.server";
import { SignInButton } from "../auth/sign-in-button";
import { SignOutButton } from "../auth/sign-out-button";
import { isOutcomeUnknown, parseRoles } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { highestRole, ROLE_LABELS } from "../organizations/roles";
import type { Route } from "./+types/invitation";

export function meta() {
  return [{ title: "Invitation · Bookkeeping" }];
}

const INVALID = "This invitation is no longer valid.";

function directory() {
  return env.DIRECTORY.getByName("directory");
}

async function findOpenInvitation(invitationId: string) {
  const invitation = await directory().findInvitation(invitationId);
  return invitation && invitation.expiresAt > Date.now() ? invitation : null;
}

/** What the invitation is to, such as "the accounting firm Lovelace & Co". */
function invitedTo({ kind, name }: Invitation["organization"]): string {
  if (kind === "operator") {
    return `${name}, the team that runs Bookkeeping`;
  }
  return kind === "firm" ? `the accounting firm ${name}` : `the books of ${name}`;
}

/**
 * Shows the invitation before signing in, so the invited person knows what they join. Its ID is
 * the secret: only the invited address receives the link.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const invitation = await findOpenInvitation(params.invitationId);
  if (!invitation) {
    return { status: "invalid" } as const;
  }
  const user = await getSessionUser(request);
  if (user) {
    requireName(request, user);
  }
  return {
    status: "open",
    invitedTo: invitedTo(invitation.organization),
    organizationName: invitation.organization.name,
    invitedBy: invitation.invitedBy,
    email: invitation.email,
    role: ROLE_LABELS[highestRole(invitation.roles)].toLowerCase(),
    signedInAs: user?.email ?? null,
  } as const;
}

/** Joins in Backoffice, which checks that the invitation is for this person's verified email. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireSessionUser(request);
  assertSameOrigin(request);
  const invitation = await findOpenInvitation(params.invitationId);
  if (!invitation) {
    return { error: INVALID };
  }
  let membership;
  try {
    const provisioning = await createProvisioningClient(env);
    membership = await provisioning.call("invitations.accept", {
      invitationId: invitation.id,
      userId: user.backofficeUserId,
    });
  } catch (error) {
    if (isOutcomeUnknown(error)) {
      return { error: "Accepting didn't work. Try again shortly." };
    }
    if (!(error instanceof BackofficeApiRequestError)) {
      throw error;
    }
    if (error.code === "forbidden") {
      return {
        error: `This invitation is for ${invitation.email}, but you're signed in as ${user.email}.`,
      };
    }
    if (error.code === "conflict" || error.code === "not_found") {
      await directory().removeInvitation(invitation.id);
      return { error: INVALID };
    }
    throw error;
  }
  const { organizationId: id, slug, name } = membership.organization;
  await directory().confirmMembership({
    organization: { id, slug, name },
    userId: user.backofficeUserId,
    roles: parseRoles(membership.roles),
    confirmedAt: Date.now(),
  });
  await directory().removeInvitation(invitation.id);
  throw redirect(organizationPath(invitation.organization.kind, slug));
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function Invitation({ loaderData, actionData, params }: Route.ComponentProps) {
  const navigation = useNavigation();
  if (loaderData.status === "invalid") {
    return (
      <section className="auth">
        <h1>{INVALID}</h1>
        <p>
          It may have expired or already been used. Ask the person who invited you for a new one.
        </p>
        <p>
          <Link to="/">Go to Bookkeeping</Link>
        </p>
      </section>
    );
  }
  const { invitedTo, organizationName, invitedBy, email, role, signedInAs } = loaderData;
  const forSomeoneElse = signedInAs !== null && signedInAs.toLowerCase() !== email.toLowerCase();
  return (
    <section className="auth">
      <h1>Join {organizationName}</h1>
      <p>
        {invitedBy} invited {email} to {invitedTo} in Bookkeeping, as {role}.
      </p>
      {signedInAs === null && (
        <>
          <SignInButton returnTo={`/invitations/${params.invitationId}`} email={email} />
          <p className="text-sm">Sign in with {email}.</p>
        </>
      )}
      {forSomeoneElse && (
        <>
          <p>
            You're signed in as {signedInAs}. Log out and sign in with {email} to accept the
            invitation.
          </p>
          <SignOutButton then={`/invitations/${params.invitationId}`} />
        </>
      )}
      {signedInAs !== null && !forSomeoneElse && (
        <Form method="post" className="space-y-3">
          <Button
            type="submit"
            variant="solid"
            className="w-full"
            disabled={navigation.state !== "idle"}
          >
            Join {organizationName}
          </Button>
          <p className="text-sm">You're signed in as {signedInAs}.</p>
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
