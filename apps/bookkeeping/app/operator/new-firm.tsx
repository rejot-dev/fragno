import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Form, Link, useNavigation } from "react-router";
import { z } from "zod";

import { assertSameOrigin } from "../auth/session.server";
import { deliverInvitation } from "../invitations/invite.server";
import { requireOperator } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { provisionFirmForInvitee, provisionOrganization } from "../organizations/provision.server";
import type { Route } from "./+types/new-firm";

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

/** Who owns the new firm: the operator, someone invited, or someone who already accepted. */
type FirmOwner =
  | { status: "you" }
  | { status: "invited"; email: string; link: string; emailed: boolean }
  | { status: "joined" };

function failed(externalId: string, error: string) {
  return { status: "failed", externalId, error } as const;
}

/**
 * Creates a firm and invites its owner, who need not have signed in yet. Backoffice creates the
 * firm with no members and a pending owner invitation from the operator, who does not become a
 * member: operators run Bookkeeping, not its firms. An operator who names themselves owns the firm
 * instead. Submitting the form again after a failure finishes the same firm and reuses the
 * invitation.
 */
export async function action({ request }: Route.ActionArgs) {
  const { user: operator } = await requireOperator(request);
  assertSameOrigin(request);
  const form = Object.fromEntries(await request.formData());
  const parsed = firmSchema.safeParse(form);
  if (!parsed.success) {
    return failed(
      z.uuid().catch(crypto.randomUUID()).parse(form.externalId),
      parsed.error.issues[0]?.message ?? "Check the form.",
    );
  }
  const { externalId, name, ownerEmail } = parsed.data;
  const unavailable = "Creating the firm didn't work. Try again shortly.";
  if (ownerEmail === operator.email.toLowerCase()) {
    const provisioned = await provisionOrganization({
      externalId,
      name,
      kind: "firm",
      ownerUserId: operator.backofficeUserId,
    });
    if (provisioned.status !== "provisioned") {
      return failed(
        externalId,
        provisioned.status === "refused" ? provisioned.message : unavailable,
      );
    }
    const { kind, slug } = provisioned.organization;
    const owner: FirmOwner = { status: "you" };
    return { status: "created", name, path: organizationPath(kind, slug), owner } as const;
  }
  const provisioned = await provisionFirmForInvitee({
    externalId,
    name,
    ownerEmail,
    invitedByUserId: operator.backofficeUserId,
  });
  if (provisioned.status !== "provisioned") {
    return failed(externalId, provisioned.status === "refused" ? provisioned.message : unavailable);
  }
  const { organization, ownerInvitation } = provisioned;
  const path = organizationPath(organization.kind, organization.slug);
  if (ownerInvitation === null) {
    const owner: FirmOwner = { status: "joined" };
    return { status: "created", name, path, owner } as const;
  }
  const { email, link, emailed } = await deliverInvitation({
    id: ownerInvitation.id,
    organization,
    email: ownerEmail,
    roles: ["owner"],
    invitedBy: operator.name,
    expiresAt: ownerInvitation.expiresAt,
  });
  const owner: FirmOwner = { status: "invited", email, link, emailed };
  return { status: "created", name, path, owner } as const;
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
      <PageHeading
        eyebrow="Operator"
        title="New firm"
        meta="Its owner gets an invitation by email. You don't become a member: the firm is theirs."
        actions={null}
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
            <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
              Create firm
            </Button>
          </Form>
        </FormContainer>
      </div>
    </div>
  );
}

/** What happens next for the firm's owner. */
function nextStep(owner: FirmOwner): string {
  if (owner.status === "you") {
    return "You are its owner.";
  }
  if (owner.status === "joined") {
    return "Its owner already accepted the invitation.";
  }
  // Backoffice queues the email; it may still not arrive, so the link is always there to share.
  return owner.emailed
    ? `We emailed ${owner.email} an invitation to own it. If it doesn't arrive, send them this link:`
    : `We couldn't email ${owner.email} their invitation. Send them this link:`;
}

function Created({ name, path, owner }: { name: string; path: string; owner: FirmOwner }) {
  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Operator" title="New firm" meta={null} actions={null} />
      <div role="status" className="max-w-2xl space-y-3 text-sm">
        <p className="font-medium">{name} was created.</p>
        <p>{nextStep(owner)}</p>
        {owner.status === "invited" && (
          <Input className="w-full" readOnly value={owner.link} aria-label="Invitation link" />
        )}
        {owner.status === "you" && (
          <p>
            <Link to={path}>Open {name}</Link>
          </p>
        )}
      </div>
    </div>
  );
}
