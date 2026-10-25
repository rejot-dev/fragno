import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { createProvisioningClient } from "../../workers/backoffice/client";
import { FUNCTIONAL_CURRENCIES, type FunctionalCurrency } from "../../workers/books/currencies";
import type { Administration } from "../../workers/directory/directory";
import { canManage } from "../../workers/directory/membership";
import { assertSameOrigin } from "../auth/session.server";
import type { ClientOutletContext } from "../clients/layout";
import { callBackoffice, requireOrganization } from "../organizations/access.server";
import type { Route } from "./+types/new";

export function meta() {
  return [{ title: "New administration · Bookkeeping" }];
}

const CURRENCIES = Object.keys(FUNCTIONAL_CURRENCIES) as FunctionalCurrency[];

const administrationSchema = z.object({
  // Chosen when the form was shown, so submitting it again finds what the first submission made.
  externalId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1, "Enter the administration's name.")
    .max(160, "Use at most 160 characters."),
  functionalCurrency: z.enum(CURRENCIES, "Choose a currency."),
});

function directory() {
  return env.DIRECTORY.getByName("directory");
}

async function requireManager(request: Request, slug: string) {
  const context = await requireOrganization(request, slug, "client");
  if (!canManage(context.roles)) {
    throw new Response("Only owners and admins create administrations.", { status: 403 });
  }
  return context;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { organization } = await requireManager(request, params.slug);
  const existing = await directory().listAdministrations(organization.id);
  return {
    externalId: crypto.randomUUID(),
    // A client's first administration is usually its business.
    suggestedName: existing.length === 0 ? organization.name : "",
  };
}

/**
 * Creates the administration's Backoffice project, opens its books, then records it. Each step
 * is idempotent, so submitting the form again after a failure finishes the steps left.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const { user, organization } = await requireManager(request, params.slug);
  assertSameOrigin(request);
  const parsed = administrationSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  const { externalId, name, functionalCurrency } = parsed.data;
  let project;
  try {
    project = await callBackoffice(async () => {
      const provisioning = await createProvisioningClient(env);
      return await provisioning.call("projects.provision", {
        organizationId: organization.id,
        externalProjectId: externalId,
        name,
        createdByUserId: user.backofficeUserId,
      });
    });
  } catch (error) {
    if (error instanceof BackofficeApiRequestError) {
      return { error: error.message };
    }
    throw error;
  }
  await env.BOOKS.getByName(project.projectId).open({ name, functionalCurrency });
  const administration: Administration = {
    id: project.projectId,
    clientId: organization.id,
    slug: project.slug,
    name,
  };
  await directory().recordAdministration(administration);
  throw redirect(`/w/${params.slug}/a/${administration.slug}`);
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function NewAdministration({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const { client } = useOutletContext<ClientOutletContext>();
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={client.name}
        title="New administration"
        meta="An administration holds the books of one business."
        actions={null}
      />
      <div className="max-w-2xl">
        <FormContainer title="Administration">
          <Form method="post" className="space-y-4">
            <input type="hidden" name="externalId" value={loaderData.externalId} />
            <Field label="Business name">
              <Input
                className="w-full"
                name="name"
                defaultValue={loaderData.suggestedName}
                autoComplete="organization"
                required
              />
            </Field>
            <Field label="Currency of the books">
              <Select
                name="functionalCurrency"
                options={CURRENCIES.map((code) => ({ label: code, value: code }))}
                defaultValue="EUR"
                required
              />
            </Field>
            {actionData?.error && (
              <p role="alert" className="text-sm text-[var(--bo-failed)]">
                {actionData.error}
              </p>
            )}
            <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
              Create administration
            </Button>
          </Form>
        </FormContainer>
      </div>
    </div>
  );
}
