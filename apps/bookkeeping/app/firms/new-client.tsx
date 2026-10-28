import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Form, Link, redirect, useNavigation } from "react-router";
import { z } from "zod";

import { canManage } from "../../workers/directory/membership";
import { assertSameOrigin } from "../auth/session.server";
import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { provisionClient } from "../organizations/provision.server";
import type { Route } from "./+types/new-client";

export function meta() {
  return [{ title: "New client · Bookkeeping" }];
}

const clientSchema = z.object({
  // Chosen when the form was shown, so submitting it again finds what the first submission made.
  externalId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1, "Enter the client's name.")
    .max(160, "Use at most 160 characters."),
});

/** Backoffice lets the firm's owners and admins create the clients it manages. */
async function requireManager(request: Request, slug: string) {
  const context = await requireOrganization(request, slug, "firm");
  if (!canManage(context.roles)) {
    throw new Response("Only the firm's owners and admins create clients.", { status: 403 });
  }
  return context;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireManager(request, params.slug);
  return { externalId: crypto.randomUUID() };
}

/**
 * Creates the client's workspace, managed by the firm, and opens its members page to invite the
 * client. Submitting it again after a failure finishes the same client.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const { organization, user } = await requireManager(request, params.slug);
  assertSameOrigin(request);
  const form = Object.fromEntries(await request.formData());
  const parsed = clientSchema.safeParse(form);
  if (!parsed.success) {
    return {
      externalId: z.uuid().catch(crypto.randomUUID()).parse(form.externalId),
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const { externalId, name } = parsed.data;
  const result = await provisionClient({
    externalId,
    name,
    firmId: organization.id,
    createdByUserId: user.backofficeUserId,
  });
  if (result.status === "unavailable") {
    return { externalId, error: "Creating the client didn't work. Try again shortly." };
  }
  if (result.status === "refused") {
    return { externalId, error: result.message };
  }
  const { kind, slug } = result.organization;
  throw redirect(`${organizationPath(kind, slug)}/members`);
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function NewClient({ loaderData, actionData, params }: Route.ComponentProps) {
  const navigation = useNavigation();
  // Keep the identifier of a failed attempt, so trying again finds what it made.
  const externalId = actionData?.externalId ?? loaderData.externalId;
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={
          <Link to={`/f/${params.slug}`} className="hover:underline">
            Clients
          </Link>
        }
        title="New client"
        meta="Everyone in the firm opens the client's workspace. Invite the client to own it next."
        actions={null}
      />
      <div className="max-w-2xl">
        <FormContainer title="Client">
          <Form method="post" className="space-y-4">
            <input type="hidden" name="externalId" value={externalId} />
            <Field label="Client name">
              <Input className="w-full" name="name" autoComplete="organization" required />
            </Field>
            {actionData && (
              <p role="alert" className="text-sm text-[var(--bo-failed)]">
                {actionData.error}
              </p>
            )}
            <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
              Create client
            </Button>
          </Form>
        </FormContainer>
      </div>
    </div>
  );
}
