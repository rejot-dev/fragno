import {
  marketplaceVisibilitySchema,
  type MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Form, Link } from "react-router";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  marketplaceListingStatusSchema,
  type MarketplaceListingStatus,
} from "@/fragno/marketplace/contracts";
import {
  decodeMarketplaceOwnedListingCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { requireRoutableScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/my-listings";
import { loadMarketplaceListingRefs } from "./listing-route.server";
import { marketplaceListingManagePath, marketplaceListingPath } from "./navigation";
import { marketplaceCatalogForVisibility } from "./scope";

const updatedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const minePath = (input: {
  basePath: string;
  visibility: MarketplaceVisibility;
  status?: MarketplaceListingStatus;
  cursor?: string;
}) => {
  const search = new URLSearchParams({ visibility: input.visibility });
  if (input.status) {
    search.set("status", input.status);
  }
  if (input.cursor) {
    search.set("cursor", input.cursor);
  }
  const query = search.toString();
  return query ? `${input.basePath}?${query}` : input.basePath;
};

export async function loader({ context, url }: Route.LoaderArgs) {
  const selectedScope = await requireRoutableScopeSelection(context);
  const routeScope = backofficeRuntimeScopeFromResolvedScope(selectedScope);

  const statusResult = marketplaceListingStatusSchema
    .optional()
    .safeParse(url.searchParams.get("status")?.trim() || undefined);
  if (!statusResult.success) {
    throw new Response("Invalid marketplace listing status.", { status: 400 });
  }
  const status = statusResult.data;
  const visibilityResult = marketplaceVisibilitySchema
    .default("public")
    .safeParse(url.searchParams.get("visibility")?.trim() || undefined);
  if (!visibilityResult.success) {
    throw new Response("Invalid marketplace visibility.", { status: 400 });
  }
  const visibility = visibilityResult.data;
  // Only organizations have their own Marketplace; user and project listings are public.
  const marketplaceScope =
    visibility === "public"
      ? { kind: "system" as const }
      : routeScope.kind === "org"
        ? routeScope
        : null;
  if (!marketplaceScope) {
    throw new Response("Invalid marketplace visibility.", { status: 400 });
  }
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  try {
    decodeMarketplaceOwnedListingCursor({
      encodedCursor: cursor,
      ownerScope: routeScope,
      status,
    });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const marketplace = context
    .get(BackofficeWorkerContext)
    .runtime.objects.marketplace.for(marketplaceScope).commands;
  const page = await marketplace.listOwnedListings({
    ownerScope: routeScope,
    status,
    cursor,
  });

  return {
    basePath: url.pathname,
    selectedScope,
    visibility,
    status: status ?? null,
    ...page,
    listingRefs: await loadMarketplaceListingRefs(
      context.get(BackofficeWorkerContext).runtime.objects,
      page.listings.map((listing) => listing.listingId),
    ),
  };
}

export function meta() {
  return [{ title: "My Marketplace Listings" }];
}

export default function BackofficeMarketplaceMyListings({ loaderData }: Route.ComponentProps) {
  const { basePath, selectedScope, visibility, status, listings, hasNextPage, nextCursor } =
    loaderData;
  const organizationSlug = selectedScope.kind === "org" ? selectedScope.organization.slug : null;

  return (
    <div className="space-y-4">
      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Publisher workspace
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">My listings</h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--bo-muted)]">
              Review drafts, published versions, and archived catalog entries owned by this scope.
            </p>
          </div>
          {organizationSlug ? (
            <ButtonLink
              to={`/backoffice/marketplace/publish?ownerOrgSlug=${encodeURIComponent(organizationSlug)}`}
              variant="accent"
            >
              New draft
            </ButtonLink>
          ) : null}
        </div>
        <Form method="get" className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          {organizationSlug ? (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Marketplace
              </span>
              <select
                name="visibility"
                defaultValue={visibility}
                className="bo-input px-3 py-2 text-sm"
              >
                <option value="public">Public</option>
                <option value="organization">Organization</option>
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Status
            </span>
            <select
              name="status"
              defaultValue={status ?? ""}
              className="bo-input px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </Form>
      </section>

      {listings.length === 0 ? (
        <section className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-6 py-16 text-center">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            No listings
          </p>
          <h2 className="mt-3 text-2xl font-semibold text-[var(--bo-fg)]">
            This publisher has no {status ?? "marketplace"} listings.
          </h2>
        </section>
      ) : (
        <section className="space-y-3">
          {listings.map((listing) => {
            const listingPath = organizationSlug
              ? marketplaceListingManagePath({
                  listingId: listing.listingId,
                  organizationSlug,
                  visibility,
                })
              : listing.latestPublishedVersion
                ? marketplaceListingPath(
                    loaderData.listingRefs[listing.listingId],
                    selectedScope,
                    marketplaceCatalogForVisibility(visibility),
                  )
                : null;
            const content = (
              <>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={listing.status} />
                    <span className="text-[10px] text-[var(--bo-muted-2)]">
                      {listing.latestPublishedVersion
                        ? `latest v${listing.latestPublishedVersion}`
                        : "not published"}
                    </span>
                  </div>
                  <h2 className="mt-3 text-xl font-semibold text-[var(--bo-fg)]">{listing.name}</h2>
                  <p className="mt-1 text-xs text-[var(--bo-muted)]">{listing.category}</p>
                </div>
                <div className="text-left md:text-right">
                  <p className="text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                    Updated
                  </p>
                  <p className="mt-1 text-sm text-[var(--bo-fg)]">
                    {updatedAtFormatter.format(new Date(listing.updatedAt))}
                  </p>
                </div>
              </>
            );
            return listingPath ? (
              <Link
                key={listing.listingId}
                to={listingPath}
                className="grid gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 transition-colors hover:border-[color:var(--bo-accent)] hover:bg-[var(--bo-panel-2)] md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
              >
                {content}
              </Link>
            ) : (
              <article
                key={listing.listingId}
                className="grid gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
              >
                {content}
              </article>
            );
          })}
        </section>
      )}

      {hasNextPage && nextCursor ? (
        <div className="flex justify-end">
          <ButtonLink
            to={minePath({
              basePath,
              visibility,
              status: status ?? undefined,
              cursor: nextCursor,
            })}
            variant="secondary"
          >
            Next page →
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: MarketplaceListingStatus }) {
  const tone =
    status === "published"
      ? "border-emerald-400/40 text-emerald-700 dark:text-emerald-200"
      : status === "draft"
        ? "border-amber-400/40 text-amber-700 dark:text-amber-200"
        : "border-[color:var(--bo-border)] text-[var(--bo-muted)]";

  return (
    <span className={`border px-2 py-1 text-[9px] tracking-[0.18em] uppercase ${tone}`}>
      {status}
    </span>
  );
}
