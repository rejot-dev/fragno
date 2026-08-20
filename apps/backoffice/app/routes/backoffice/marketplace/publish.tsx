import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import {
  MARKETPLACE_CATEGORIES,
  marketplaceCreateDraftListingInputSchema,
} from "@/fragno/marketplace/contracts";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/publish";
import { marketplaceListingManagePath } from "./navigation";
import { marketplaceOwnerForOrganization } from "./publisher.server";
import { marketplaceScopeTabPath } from "./scope";

type PublishActionData = { ok: false; message: string };

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organizations = me.organizations.map(({ organization }) => ({
    id: organization.id,
    name: organization.name,
  }));
  const requestedOrganizationId = url.searchParams.get("ownerOrgId")?.trim() || null;
  const requestedOrganization = requestedOrganizationId
    ? organizations.find(({ id }) => id === requestedOrganizationId)
    : null;
  if (requestedOrganizationId && !requestedOrganization) {
    throw new Response("Publisher organisation was not found.", { status: 404 });
  }
  const activeOrganizationId =
    requestedOrganization?.id ??
    me.activeOrganization?.organization.id ??
    organizations[0]?.id ??
    null;

  return { organizations, activeOrganizationId };
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const formData = await request.formData();
  const owner = marketplaceOwnerForOrganization(
    me,
    String(formData.get("ownerOrgId") ?? "").trim(),
  );
  if (!owner) {
    return {
      ok: false,
      message: "Select an organisation you are allowed to publish for.",
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

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
  const operation = await marketplace.createDraftListing(input.data);
  if (!operation.ok) {
    return { ok: false, message: operation.error.message } satisfies PublishActionData;
  }

  const result = operation.value;
  return redirect(
    marketplaceListingManagePath({
      listingId: result.listingId,
      organizationId: owner.scope.orgId,
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
          <Link
            to={
              loaderData.activeOrganizationId
                ? marketplaceScopeTabPath(
                    {
                      kind: "org",
                      orgId: loaderData.activeOrganizationId,
                      label:
                        loaderData.organizations.find(
                          ({ id }) => id === loaderData.activeOrganizationId,
                        )?.name ?? loaderData.activeOrganizationId,
                    },
                    "my-listings",
                  )
                : "/backoffice/marketplace"
            }
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            My listings
          </Link>
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
          <Field label="Slug" name="slug" placeholder="daily-operations-brief" />
          <Field label="Initial version" name="version" placeholder="1.0.0" />
          <Field label="Name" name="name" placeholder="Daily operations brief" />
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Category
            </span>
            <select
              name="category"
              required
              defaultValue="operations"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            >
              {MARKETPLACE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Publisher organisation
            </span>
            <select
              name="ownerOrgId"
              required
              defaultValue={loaderData.activeOrganizationId ?? ""}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            >
              <option value="" disabled>
                Select an organisation
              </option>
              {loaderData.organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Summary"
            name="summary"
            placeholder="Build and deliver a concise daily operations report."
            className="md:col-span-2"
          />
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Description
            </span>
            <textarea
              name="description"
              required
              rows={8}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            />
          </label>
          <Field
            label="Tags"
            name="tags"
            placeholder="reporting, scheduled"
            required={false}
            className="md:col-span-2"
          />
          <button
            type="submit"
            disabled={isSubmitting || loaderData.organizations.length === 0}
            className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60 md:col-span-2"
          >
            {isSubmitting ? "Creating draft…" : "Create private draft"}
          </button>
        </Form>
      </FormContainer>
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  className,
  required = true,
}: {
  label: string;
  name: string;
  placeholder: string;
  className?: string;
  required?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </span>
      <input
        name={name}
        required={required}
        placeholder={placeholder}
        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
      />
    </label>
  );
}
