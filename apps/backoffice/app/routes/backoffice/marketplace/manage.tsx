import { Form, Link, redirect, useActionData, useLocation, useNavigation } from "react-router";

import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  MARKETPLACE_CATEGORIES,
  marketplaceAddDraftVersionInputSchema,
  marketplaceListingMetadataSchema,
  marketplacePublishVersionInputSchema,
} from "@/fragno/marketplace/contracts";
import {
  decodeMarketplaceOwnedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/manage";
import {
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRefSchema,
} from "./navigation";
import { marketplaceOwnerForOrganization } from "./publisher.server";
import { marketplaceScopeTabPath } from "./scope";

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

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const listingIdResult = marketplaceListingRefSchema.safeParse(params.listingRef);
  if (!listingIdResult.success) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestedOrganizationId = url.searchParams.get("organizationId")?.trim();
  const organizationId =
    requestedOrganizationId ??
    me.activeOrganization?.organization.id ??
    me.organizations[0]?.organization.id ??
    null;
  if (!organizationId || !marketplaceOwnerForOrganization(me, organizationId)) {
    throw new Response("Publisher organisation was not found.", { status: 404 });
  }

  const versionCursor = url.searchParams.get("versionCursor")?.trim() || undefined;
  try {
    decodeMarketplaceOwnedVersionCursor({
      encodedCursor: versionCursor,
      listingId: listingIdResult.data,
    });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
  const detail = await marketplace.getOwnedListing({
    listingId: listingIdResult.data,
    ownerScope: { kind: "org", orgId: organizationId },
    versionCursor,
  });
  if (!detail) {
    throw new Response("Not Found", { status: 404 });
  }

  return { organizationId, ...detail };
}

export async function action({ request, params, context, url }: Route.ActionArgs) {
  const listingIdResult = marketplaceListingRefSchema.safeParse(params.listingRef);
  if (!listingIdResult.success) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const formData = await request.formData();
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const owner = marketplaceOwnerForOrganization(me, organizationId);
  if (!owner) {
    return {
      ok: false,
      message: "Select an organisation you can publish for.",
    } satisfies ManageActionData;
  }

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
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
      listingId: listingIdResult.data,
      owner,
      metadata: metadataResult.data,
    });
    if (!operation.ok) {
      return { ok: false, message: operation.error.message } satisfies ManageActionData;
    }
    return redirect(
      marketplaceListingManagePath({
        listingId: listingIdResult.data,
        organizationId,
        result: { updated: "1" },
      }),
    );
  }

  if (intent === "add-version") {
    const input = marketplaceAddDraftVersionInputSchema.safeParse({
      listingId: listingIdResult.data,
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
        listingId: listingIdResult.data,
        organizationId,
        result: {
          created: result.version,
          ...(result.created ? {} : { reused: "1" }),
        },
      }),
    );
  }

  if (intent === "publish") {
    const input = marketplacePublishVersionInputSchema.safeParse({
      listingId: listingIdResult.data,
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
        listingId: listingIdResult.data,
        organizationId,
        result: {
          published: result.version,
          ...(result.published ? {} : { reused: "1" }),
        },
      }),
    );
  }

  if (intent === "archive") {
    const operation = await marketplace.archiveListing({
      listingId: listingIdResult.data,
      owner,
    });
    if (!operation.ok) {
      return { ok: false, message: operation.error.message } satisfies ManageActionData;
    }
    const result = operation.value;
    return redirect(
      marketplaceListingManagePath({
        listingId: listingIdResult.data,
        organizationId,
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
  const { organizationId, listing, versions, nextVersionCursor, hasNextVersionPage } = loaderData;
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
          : `Version ${search.get("published")} is now public.`
        : search.get("archived")
          ? search.get("reused")
            ? "The listing was already archived."
            : "The listing was removed from the public marketplace."
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
              { kind: "org", orgId: organizationId, label: organizationId },
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
            <Link
              to={marketplaceListingPath(listing.listingId, {
                kind: "org",
                orgId: organizationId,
                label: organizationId,
              })}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              View public page
            </Link>
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
            description="This metadata describes the marketplace entry independently of its future uploaded artifact."
          >
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="organizationId" value={organizationId} />
              <MetadataField label="Name" name="name" defaultValue={listing.name} />
              <MetadataField label="Summary" name="summary" defaultValue={listing.summary} />
              <label className="flex flex-col gap-1">
                <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                  Description
                </span>
                <textarea
                  name="description"
                  required
                  rows={8}
                  defaultValue={listing.description}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                  Category
                </span>
                <select
                  name="category"
                  defaultValue={listing.category}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
                >
                  {MARKETPLACE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
              <MetadataField
                label="Tags"
                name="tags"
                defaultValue={listing.tags.join(", ")}
                required={false}
              />
              <button
                type="submit"
                disabled={isSubmitting}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-fg)] uppercase hover:border-[color:var(--bo-accent)] disabled:opacity-60"
              >
                Save metadata
              </button>
            </Form>
          </FormContainer>

          <FormContainer
            eyebrow="Version staging"
            title="Add a draft version"
            description="Only the semantic version is recorded for now. A named upload can be attached later."
          >
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="add-version" />
              <input type="hidden" name="organizationId" value={organizationId} />
              <MetadataField label="Version" name="version" defaultValue="" />
              <button
                type="submit"
                disabled={isSubmitting}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-fg)] uppercase hover:border-[color:var(--bo-accent)] disabled:opacity-60"
              >
                Add draft version
              </button>
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
                label="Latest public"
                value={
                  listing.latestPublishedVersion ? `v${listing.latestPublishedVersion}` : "None"
                }
              />
            </dl>
            {listing.status !== "archived" ? (
              <Form method="post" className="mt-5 border-t border-[color:var(--bo-border)] pt-4">
                <input type="hidden" name="intent" value="archive" />
                <input type="hidden" name="organizationId" value={organizationId} />
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
                        <input type="hidden" name="organizationId" value={organizationId} />
                        <input type="hidden" name="version" value={version.version} />
                        <button
                          type="submit"
                          disabled={isSubmitting}
                          className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase disabled:opacity-60"
                        >
                          {canRestore ? "Restore listing" : "Publish version"}
                        </button>
                      </Form>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {hasNextVersionPage && nextVersionCursor ? (
              <Link
                to={marketplaceListingManagePath({
                  listingId: listing.listingId,
                  organizationId,
                  result: { versionCursor: nextVersionCursor },
                })}
                className="mt-3 block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-center text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase hover:border-[color:var(--bo-accent)]"
              >
                Older versions →
              </Link>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

function MetadataField({
  label,
  name,
  defaultValue,
  required = true,
}: {
  label: string;
  name: string;
  defaultValue: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </span>
      <input
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
      />
    </label>
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
