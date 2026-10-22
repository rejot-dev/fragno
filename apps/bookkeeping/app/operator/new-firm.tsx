import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Form, Link, useNavigation } from "react-router";
import { z } from "zod";

import { assertSameOrigin } from "../auth/session.server";
import { invite } from "../invitations/invite.server";
import { organizationPath } from "../organizations/paths";
import { provisionOrganization } from "../organizations/provision.server";
import type { Route } from "./+types/new-firm";
import { requireOperator } from "./operator.server";

export function meta() {
  return [{ title: "New firm · Bookkeeping" }];
}

const firmSchema = z.object({
  // Chosen when the form was shown, so submitting it again finds what the first submission made.
  externalId: z.uuid(),
  name: z.string().trim().min(1, "Enter the firm's name.").max(160, "Use at most 160 characters."),
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email("Enter the owner's email address.")),
});

export async function loader({ request }: Route.LoaderArgs) {
  await requireOperator(request);
  return { externalId: crypto.randomUUID() };
}

const BREADCRUMBS = [{ label: "Operator", to: "/operator" }, { label: "New firm" }];

/** The invitation for the firm's owner; null when the operator is the owner. */
type OwnerInvitation = { email: string; link: string; emailed: boolean } | null;

/**
 * Creates a firm's organization and invites its owner, who need not have signed in yet. Backoffice
 * only makes someone who has authorized Bookkeeping an owner, so the operator owns it first and
 * invites the owner as themselves; the operator stays an owner too. Submitting the form again
 * after a failure finishes the same firm and reuses the invitation.
 */
export async function action({ request }: Route.ActionArgs) {
  const operator = await requireOperator(request);
  assertSameOrigin(request);
  const form = Object.fromEntries(await request.formData());
  const parsed = firmSchema.safeParse(form);
  if (!parsed.success) {
    return {
      status: "failed",
      externalId: z.uuid().catch(crypto.randomUUID()).parse(form.externalId),
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    } as const;
  }
  const { externalId, name, ownerEmail } = parsed.data;
  const provisioned = await provisionOrganization({
    externalId,
    name,
    kind: "firm",
    ownerUserId: operator.backofficeUserId,
  });
  if (provisioned.status === "unavailable") {
    return {
      status: "failed",
      externalId,
      error: "Creating the firm didn't work. Try again shortly.",
    } as const;
  }
  if (provisioned.status === "refused") {
    return { status: "failed", externalId, error: provisioned.message } as const;
  }
  const { organization } = provisioned;
  const path = organizationPath(organization.kind, organization.slug);
  if (ownerEmail === operator.email.toLowerCase()) {
    return { status: "created", name, path, invitation: null } as const;
  }
  const invited = await invite({
    organization,
    inviter: operator,
    email: ownerEmail,
    roles: ["owner"],
  });
  if (invited.status === "unavailable") {
    return {
      status: "failed",
      externalId,
      error: `${name} was created, but its owner was not invited yet. Try again shortly.`,
    } as const;
  }
  if (invited.status === "refused") {
    return { status: "failed", externalId, error: invited.message } as const;
  }
  const invitation: OwnerInvitation = {
    email: invited.email,
    link: invited.link,
    emailed: invited.emailed,
  };
  return { status: "created", name, path, invitation } as const;
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function NewFirm({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  if (actionData?.status === "created") {
    return <Created {...actionData} />;
  }
  // Keep the identifier of a failed attempt, so trying again finds what it made.
  const externalId = actionData?.externalId ?? loaderData.externalId;
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="New firm"
        description="Its owner gets an invitation by email. You become an owner too, so you can help."
        breadcrumbs={BREADCRUMBS}
      />
      <div className="max-w-2xl">
        <FormContainer title="Firm">
          <Form method="post" className="space-y-4">
            <input type="hidden" name="externalId" value={externalId} />
            <Field label="Firm name">
              <Input className="w-full" name="name" autoComplete="organization" required />
            </Field>
            <Field label="Owner's email">
              <Input
                className="w-full"
                name="ownerEmail"
                type="email"
                autoComplete="off"
                required
              />
            </Field>
            {actionData?.status === "failed" && (
              <p role="alert" className="text-sm text-[var(--bo-failed)]">
                {actionData.error}
              </p>
            )}
            <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
              Create firm
            </Button>
          </Form>
        </FormContainer>
      </div>
    </div>
  );
}

function Created({
  name,
  path,
  invitation,
}: {
  name: string;
  path: string;
  invitation: OwnerInvitation;
}) {
  // Backoffice queues the email; it may still not arrive, so the link is always there to share.
  let next = "You are its owner.";
  if (invitation !== null) {
    next = invitation.emailed
      ? `We emailed ${invitation.email} an invitation to own it. If it doesn't arrive, send them this link:`
      : `We couldn't email ${invitation.email} their invitation. Send them this link:`;
  }
  return (
    <div className="space-y-6">
      <BackofficePageHeader title="New firm" breadcrumbs={BREADCRUMBS} />
      <div role="status" className="max-w-2xl space-y-3 text-sm">
        <p className="font-medium">{name} was created.</p>
        <p>{next}</p>
        {invitation !== null && (
          <Input className="w-full" readOnly value={invitation.link} aria-label="Invitation link" />
        )}
        <p>
          <Link to={path}>Open {name}</Link>
        </p>
      </div>
    </div>
  );
}
