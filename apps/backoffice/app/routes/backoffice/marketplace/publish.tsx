import {
  MARKETPLACE_CATEGORIES,
  marketplaceVisibilitySchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Select } from "@fragno-private/design-system/select";
import { TextArea } from "@fragno-private/design-system/text-area";
import { Form, redirect, useActionData, useNavigation } from "react-router";

import { backofficeOrganizationContextScope } from "@/backoffice-runtime/resolved-scope";
import { marketplaceCreateDraftListingInputSchema } from "@/fragno/marketplace/contracts";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/publish";
import { marketplaceListingManagePath } from "./navigation";
import { marketplaceForPublisher, marketplaceOwnerForOrganization } from "./publisher.server";
import { marketplaceScopeTabPath } from "./scope";

type PublishActionData = { ok: false; message: string };

export async function loader({ context, url }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const organizations = me.organizations.map(({ organization }) => ({
    id: organization.id,
    slug: organization.slug,
    jurisdiction: organization.jurisdiction,
    name: organization.name,
  }));
  const requestedOrganizationSlug = url.searchParams.get("ownerOrgSlug")?.trim() || null;
  const requestedOrganization = requestedOrganizationSlug
    ? organizations.find(({ slug }) => slug === requestedOrganizationSlug)
    : null;
  if (requestedOrganizationSlug && !requestedOrganization) {
    throw new Response("Publisher organization was not found.", { status: 404 });
  }
  const activeOrganization =
    requestedOrganization ??
    organizations.find(({ id }) => id === me.activeOrganization?.organization.id) ??
    null;

  return { organizations, activeOrganization };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { me } = getBackofficeShellRequest(context);

  const formData = await request.formData();
  const organizationSlug = String(formData.get("ownerOrgSlug") ?? "").trim();
  const organization = me.organizations.find(
    ({ organization: candidate }) => candidate.slug === organizationSlug,
  )?.organization;
  const owner = organization ? marketplaceOwnerForOrganization(me, organization.id) : null;
  if (!organization || !owner) {
    return {
      ok: false,
      message: "Select an organization you are allowed to publish for.",
    } satisfies PublishActionData;
  }

  const visibility = marketplaceVisibilitySchema.safeParse(formData.get("visibility"));
  if (!visibility.success) {
    return {
      ok: false,
      message: "Choose who can see this listing.",
    } satisfies PublishActionData;
  }

  const input = marketplaceCreateDraftListingInputSchema.safeParse({
    owner,
    slug: formData.get("slug"),
    version: formData.get("version"),
    metadata: {
      name: formData.get("name"),
      summary: formData.get("summary"),
      description: formData.get("description"),
      category: formData.get("category"),
      tags: String(formData.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    },
  });
  if (!input.success) {
    return {
      ok: false,
      message: input.error.issues[0]?.message ?? "Marketplace metadata is invalid.",
    } satisfies PublishActionData;
  }

  const marketplace = marketplaceForPublisher(
    context.get(BackofficeWorkerContext).runtime.objects,
    backofficeOrganizationContextScope(organization),
    visibility.data,
  );
  const operation = await marketplace.createDraftListing(input.data);
  if (!operation.ok) {
    return { ok: false, message: operation.error.message } satisfies PublishActionData;
  }

  const result = operation.value;
  return redirect(
    marketplaceListingManagePath({
      listingId: result.listingId,
      organizationSlug,
      visibility: visibility.data,
      result: {
        created: result.version,
        ...(result.created ? {} : { reused: "1" }),
      },
    }),
  );
}

export function meta() {
  return [{ title: "Create Automation Draft · Marketplace" }];
}

export default function BackofficeMarketplacePublish({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Marketplace", to: "/backoffice/marketplace" },
          { label: "New draft" },
        ]}
        eyebrow="Publisher workspace"
        title="Create a marketplace draft."
        description="Record the catalog metadata now. A named upload can be attached to a version later."
        actions={
          <ButtonLink
            to={
              loaderData.activeOrganization
                ? marketplaceScopeTabPath(
                    {
                      kind: "org",
                      organization: loaderData.activeOrganization,
                      label: loaderData.activeOrganization.name,
                    },
                    "my-listings",
                  )
                : "/backoffice/marketplace"
            }
            variant="secondary"
          >
            My listings
          </ButtonLink>
        }
      />

      <FormContainer
        eyebrow="Catalog metadata"
        title="Describe the automation"
        description="No files or executable package contents are stored by the marketplace yet."
      >
        {actionData?.message ? (
          <div className="mb-4 border border-red-400/40 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-200">
            {actionData.message}
          </div>
        ) : null}

        <Form method="post" className="grid gap-4 md:grid-cols-2">
          <Field label="Slug">
            <Input name="slug" required placeholder="daily-operations-brief" className="w-full" />
          </Field>
          <Field label="Initial version">
            <Input name="version" required placeholder="1.0.0" className="w-full" />
          </Field>
          <Field label="Name">
            <Input name="name" required placeholder="Daily operations brief" className="w-full" />
          </Field>
          <Field label="Category">
            <Select
              name="category"
              required
              defaultValue="operations"
              options={MARKETPLACE_CATEGORIES.map((category) => ({
                label: category,
                value: category,
              }))}
            />
          </Field>
          <Field label="Publisher organization" className="md:col-span-2">
            <Select
              name="ownerOrgSlug"
              required
              defaultValue={loaderData.activeOrganization?.slug ?? null}
              placeholder="Select an organization"
              options={loaderData.organizations.map((organization) => ({
                label: organization.name,
                value: organization.slug,
              }))}
            />
          </Field>
          <Field label="Visibility" className="md:col-span-2">
            <Select
              name="visibility"
              required
              defaultValue={null}
              placeholder="Choose who can see this listing"
              options={[
                { label: "Organization members only", value: "organization" },
                { label: "Public", value: "public" },
              ]}
            />
          </Field>
          <Field label="Summary" className="md:col-span-2">
            <Input
              name="summary"
              required
              placeholder="Build and deliver a concise daily operations report."
              className="w-full"
            />
          </Field>
          <Field label="Description" className="md:col-span-2">
            <TextArea name="description" required rows={8} />
          </Field>
          <Field label="Tags" className="md:col-span-2">
            <Input name="tags" placeholder="reporting, scheduled" className="w-full" />
          </Field>
          <Button
            type="submit"
            disabled={isSubmitting || loaderData.organizations.length === 0}
            variant="accent"
            className="md:col-span-2"
          >
            {isSubmitting ? "Creating draft…" : "Create private draft"}
          </Button>
        </Form>
      </FormContainer>
    </div>
  );
}
