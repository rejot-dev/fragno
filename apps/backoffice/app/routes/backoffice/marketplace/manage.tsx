import {
  MARKETPLACE_CATEGORIES,
  marketplaceListingMetadataSchema,
  marketplaceVisibilitySchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Select } from "@fragno-private/design-system/select";
import { TextArea } from "@fragno-private/design-system/text-area";
import { Form, redirect, useActionData, useLocation, useNavigation } from "react-router";

import {
  backofficeOrganizationContextScope,
  backofficeOrganizationIdentity,
} from "@/backoffice-runtime/resolved-scope";
import {
  marketplaceAddDraftVersionInputSchema,
  marketplacePublishVersionInputSchema,
} from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  decodeMarketplaceOwnedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/manage";
import {
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRouteSchema,
} from "./navigation";
import { marketplaceForPublisher, marketplaceOwnerForOrganization } from "./publisher.server";
import { marketplaceCatalogForVisibility, marketplaceScopeTabPath } from "./scope";

type ManageActionData = { ok: false; message: string };

const versionDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export async function loader({ params, context, url }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const route = marketplaceListingRouteSchema.safeParse(params);
  if (!route.success || !route.data.publisher.startsWith("@")) {
    throw new Response("Not Found", { status: 404 });
  }
  const organization = me.organizations.find(
    ({ organization: candidate }) => `@${candidate.slug}` === route.data.publisher,
  )?.organization;
  const owner = organization ? marketplaceOwnerForOrganization(me, organization.id) : null;
  if (!organization || !owner) {
    throw new Response("Publisher organization was not found.", { status: 404 });
  }
  const listingId = marketplaceListingId({ ownerScope: owner.scope, slug: route.data.packageSlug });
  const visibility = marketplaceVisibilitySchema.safeParse(url.searchParams.get("visibility"));
  if (!visibility.success) {
    throw new Response("Marketplace visibility is required.", { status: 400 });
  }
  const versionCursor = url.searchParams.get("versionCursor")?.trim() || undefined;
  try {
    decodeMarketplaceOwnedVersionCursor({
      encodedCursor: versionCursor,
      listingId,
    });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const marketplace = marketplaceForPublisher(
    context.get(BackofficeWorkerContext).runtime.objects,
    backofficeOrganizationContextScope(organization),
    visibility.data,
  );
  const detail = await marketplace.getOwnedListing({
    listingId,
    ownerScope: { kind: "org", orgId: organization.id },
    versionCursor,
  });
  if (!detail) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    organization: backofficeOrganizationIdentity(organization),
    visibility: visibility.data,
    ...detail,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const route = marketplaceListingRouteSchema.safeParse(params);
  if (!route.success || !route.data.publisher.startsWith("@")) {
    throw new Response("Not Found", { status: 404 });
  }

  const { me } = getBackofficeShellRequest(context);

  const formData = await request.formData();
  const organizationSlug = route.data.publisher.slice(1);
  const organization = me.organizations.find(
    ({ organization: candidate }) => candidate.slug === organizationSlug,
  )?.organization;
  const owner = organization ? marketplaceOwnerForOrganization(me, organization.id) : null;
  if (!organization || !owner) {
    return {
      ok: false,
      message: "Select an organization you can publish for.",
    } satisfies ManageActionData;
  }
  const listingId = marketplaceListingId({ ownerScope: owner.scope, slug: route.data.packageSlug });
  const visibilityResult = marketplaceVisibilitySchema.safeParse(formData.get("visibility"));
  if (!visibilityResult.success) {
    return { ok: false, message: "Marketplace visibility is required." } satisfies ManageActionData;
  }
  const visibility = visibilityResult.data;

  const marketplace = marketplaceForPublisher(
    context.get(BackofficeWorkerContext).runtime.objects,
    backofficeOrganizationContextScope(organization),
    visibility,
  );
  const intent = String(formData.get("intent") ?? "");

  if (intent === "update") {
    const metadataResult = marketplaceListingMetadataSchema.safeParse({
      name: formData.get("name"),
      summary: formData.get("summary"),
      description: formData.get("description"),
      category: formData.get("category"),
      tags: String(formData.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    if (!metadataResult.success) {
      return {
        ok: false,
        message: metadataResult.error.issues[0]?.message ?? "Listing metadata is invalid.",
      } satisfies ManageActionData;
    }

    const operation = await marketplace.updateListing({
      listingId,
      owner,
      metadata: metadataResult.data,
    });
    if (!operation.ok) {
      return { ok: false, message: operation.error.message } satisfies ManageActionData;
    }
    return redirect(
      marketplaceListingManagePath({
        listingId,
        organizationSlug,
        visibility,
        result: { updated: "1" },
      }),
    );
  }

  if (intent === "add-version") {
    const input = marketplaceAddDraftVersionInputSchema.safeParse({
      listingId,
      version: formData.get("version"),
      owner,
    });
    if (!input.success) {
      return {
        ok: false,
        message: input.error.issues[0]?.message ?? "Version is invalid.",
      } satisfies ManageActionData;
    }
    const operation = await marketplace.addDraftVersion(input.data);
    if (!operation.ok) {
      return { ok: false, message: operation.error.message } satisfies ManageActionData;
    }
    const result = operation.value;
    return redirect(
      marketplaceListingManagePath({
        listingId,
        organizationSlug,
        visibility,
        result: {
          created: result.version,
          ...(result.created ? {} : { reused: "1" }),
        },
      }),
    );
  }

  if (intent === "publish") {
    const input = marketplacePublishVersionInputSchema.safeParse({
      listingId,
      version: formData.get("version"),
      owner,
    });
    if (!input.success) {
      return {
        ok: false,
        message: input.error.issues[0]?.message ?? "Select a valid version to publish.",
      } satisfies ManageActionData;
    }
    const operation = await marketplace.publishVersion(input.data);
    if (!operation.ok) {
      return { ok: false, message: operation.error.message } satisfies ManageActionData;
    }
    const result = operation.value;
    return redirect(
      marketplaceListingManagePath({
        listingId,
        organizationSlug,
        visibility,
        result: {
          published: result.version,
          ...(result.published ? {} : { reused: "1" }),
        },
      }),
    );
  }

  if (intent === "archive") {
    const operation = await marketplace.archiveListing({
      listingId,
      owner,
    });
    if (!operation.ok) {
      return { ok: false, message: operation.error.message } satisfies ManageActionData;
    }
    const result = operation.value;
    return redirect(
      marketplaceListingManagePath({
        listingId,
        organizationSlug,
        visibility,
        result: {
          archived: "1",
          ...(result.archived ? {} : { reused: "1" }),
        },
      }),
    );
  }

  return { ok: false, message: "Unknown marketplace operation." } satisfies ManageActionData;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `Manage ${loaderData.listing.name} · Marketplace`
        : "Manage Marketplace Listing",
    },
  ];
}

export default function BackofficeMarketplaceManage({ loaderData }: Route.ComponentProps) {
  const { organization, visibility, listing, versions, nextVersionCursor, hasNextVersionPage } =
    loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const isSubmitting = navigation.state === "submitting";

  const notification = search.get("updated")
    ? "Listing metadata was updated."
    : search.get("created")
      ? search.get("reused")
        ? `Version ${search.get("created")} already existed.`
        : `Draft version ${search.get("created")} was created.`
      : search.get("published")
        ? search.get("reused")
          ? `Version ${search.get("published")} was already the latest published version.`
          : visibility === "public"
            ? `Version ${search.get("published")} is now public.`
            : `Version ${search.get("published")} is now available to organization members.`
        : search.get("archived")
          ? search.get("reused")
            ? "The listing was already archived."
            : "The listing was removed from the marketplace."
          : null;

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Marketplace", to: "/backoffice/marketplace" },
          {
            label: "My listings",
            to: marketplaceScopeTabPath(
              {
                kind: "org",
                organization,
                label: organization.id,
              },
              "my-listings",
            ),
          },
          { label: listing.name },
        ]}
        eyebrow={`${listing.status} listing`}
        title={listing.name}
        description={listing.summary}
        actions={
          listing.status === "published" ? (
            <ButtonLink
              to={marketplaceListingPath(
                `@${organization.slug}/${listing.slug}`,
                { kind: "org", organization, label: organization.id },
                marketplaceCatalogForVisibility(visibility),
              )}
              variant="secondary"
            >
              {visibility === "public" ? "View public page" : "View listing"}
            </ButtonLink>
          ) : null
        }
      />

      {notification ? (
        <div className="border border-emerald-400/40 bg-emerald-500/12 p-4 text-sm text-emerald-700 dark:text-emerald-200">
          {notification}
        </div>
      ) : null}
      {actionData?.message ? (
        <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
          {actionData.message}
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <FormContainer
            eyebrow="Catalog metadata"
            title="Edit listing presentation"
            description="This metadata describes the marketplace entry independently of its future uploaded package."
          >
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="visibility" value={visibility} />
              <Field label="Name">
                <Input name="name" required defaultValue={listing.name} className="w-full" />
              </Field>
              <Field label="Summary">
                <Input name="summary" required defaultValue={listing.summary} className="w-full" />
              </Field>
              <Field label="Description">
                <TextArea name="description" required rows={8} defaultValue={listing.description} />
              </Field>
              <Field label="Category">
                <Select
                  name="category"
                  defaultValue={listing.category}
                  options={MARKETPLACE_CATEGORIES.map((category) => ({
                    label: category,
                    value: category,
                  }))}
                />
              </Field>
              <Field label="Tags">
                <Input name="tags" defaultValue={listing.tags.join(", ")} className="w-full" />
              </Field>
              <Button type="submit" disabled={isSubmitting} variant="secondary">
                Save metadata
              </Button>
            </Form>
          </FormContainer>

          <FormContainer
            eyebrow="Version staging"
            title="Add a draft version"
            description="Only the semantic version is recorded for now. A named upload can be attached later."
          >
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="add-version" />
              <input type="hidden" name="visibility" value={visibility} />
              <Field label="Version">
                <Input name="version" required className="w-full" />
              </Field>
              <Button type="submit" disabled={isSubmitting} variant="secondary">
                Add draft version
              </Button>
            </Form>
          </FormContainer>
        </div>

        <aside className="space-y-4">
          <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Listing state
            </p>
            <dl className="mt-4 space-y-3 text-sm">
              <StateRow label="Status" value={listing.status} />
              <StateRow label="Publisher" value={listing.publisherName} />
              <StateRow
                label="Visibility"
                value={visibility === "public" ? "Public" : "Organization members"}
              />
              <StateRow
                label="Latest public"
                value={
                  listing.latestPublishedVersion ? `v${listing.latestPublishedVersion}` : "None"
                }
              />
            </dl>
            {listing.status !== "archived" ? (
              <Form method="post" className="mt-5 border-t border-[color:var(--bo-border)] pt-4">
                <input type="hidden" name="intent" value="archive" />
                <input type="hidden" name="visibility" value={visibility} />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full border border-red-400/40 bg-red-500/8 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] text-red-700 uppercase hover:border-red-400/70 dark:text-red-200"
                >
                  Archive listing
                </button>
              </Form>
            ) : null}
          </section>

          <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Versions
            </p>
            <div className="mt-3 space-y-3">
              {versions.map((version) => {
                const canRestore =
                  listing.status === "archived" &&
                  version.status === "published" &&
                  version.version === listing.latestPublishedVersion;
                return (
                  <article
                    key={version.version}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
                        v{version.version}
                      </span>
                      <VersionStatus status={version.status} />
                    </div>
                    <p className="mt-2 text-[10px] text-[var(--bo-muted-2)]">
                      {versionDateFormatter.format(new Date(version.createdAt))}
                    </p>
                    {version.status === "draft" || canRestore ? (
                      <Form method="post" className="mt-3">
                        <input type="hidden" name="intent" value="publish" />
                        <input type="hidden" name="visibility" value={visibility} />
                        <input type="hidden" name="version" value={version.version} />
                        <Button
                          type="submit"
                          disabled={isSubmitting}
                          variant="accent"
                          className="w-full"
                        >
                          {canRestore ? "Restore listing" : "Publish version"}
                        </Button>
                      </Form>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {hasNextVersionPage && nextVersionCursor ? (
              <ButtonLink
                to={marketplaceListingManagePath({
                  listingId: listing.listingId,
                  organizationSlug: organization.slug,
                  visibility,
                  result: { versionCursor: nextVersionCursor },
                })}
                variant="secondary"
                className="mt-3 w-full"
              >
                Older versions →
              </ButtonLink>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-[var(--bo-muted-2)]">{label}</dt>
      <dd className="text-right text-[var(--bo-fg)]">{value}</dd>
    </div>
  );
}

function VersionStatus({ status }: { status: "draft" | "published" }) {
  return (
    <span
      className={
        status === "published"
          ? "border border-emerald-400/40 px-2 py-1 text-[8px] tracking-[0.16em] text-emerald-700 uppercase dark:text-emerald-200"
          : "border border-amber-400/40 px-2 py-1 text-[8px] tracking-[0.16em] text-amber-700 uppercase dark:text-amber-200"
      }
    >
      {status}
    </span>
  );
}
