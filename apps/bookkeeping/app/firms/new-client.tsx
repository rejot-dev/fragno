import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Form, redirect, useNavigation } from "react-router";
import { z } from "zod";

import { assertSameOrigin } from "../auth/session.server";
import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { provisionOrganization } from "../organizations/provision.server";
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

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireOrganization(request, params.slug, "firm");
  return { externalId: crypto.randomUUID() };
}

/**
 * Creates the client's workspace, owned by the person creating it, and opens its members page to
 * invite the client. Submitting it again after a failure finishes the same client.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const { organization, user } = await requireOrganization(request, params.slug, "firm");
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
  const result = await provisionOrganization({
    externalId,
    name,
    kind: "client",
    firmId: organization.id,
    ownerUserId: user.backofficeUserId,
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
      <BackofficePageHeader
        title="New client"
        description="You become the owner of the client's workspace, and invite the client next."
        breadcrumbs={[{ label: "Clients", to: `/f/${params.slug}` }, { label: "New client" }]}
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
            <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
              Create client
            </Button>
          </Form>
        </FormContainer>
      </div>
    </div>
  );
}
