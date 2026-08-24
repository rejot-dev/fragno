import { Link, useOutletContext } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import {
  decodeMarketplaceListingCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/browse";
import type { MarketplaceLayoutContext } from "./layout-context";
import { marketplaceListingPath } from "./navigation";

const publishedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function marketplacePagePath(basePath: string, cursor: string): string {
  return `${basePath}?${new URLSearchParams({ cursor })}`;
}

function formatPublishedAt(value: string): string {
  return publishedAtFormatter.format(new Date(value));
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  try {
    decodeMarketplaceListingCursor({ encodedCursor: cursor });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
  const page = await marketplace.listPublishedListings(cursor ? { cursor } : {});
  return { basePath: url.pathname, ...page };
}

export function meta() {
  return [
    { title: "Automation Marketplace" },
    {
      name: "description",
      content: "Discover versioned automation packages ready to install.",
    },
  ];
}

export default function BackofficeMarketplaceBrowse({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();
  const { basePath, listings, nextCursor, hasNextPage } = loaderData;

  return (
    <div className="space-y-5">
      {listings.length === 0 ? (
        <section className="bo-panel-surface bg-[var(--bo-panel)] px-6 py-16 text-center">
          <p className="font-mono text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            Featured automations
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
            No published automations yet.
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Published packages will appear here when they are ready to install.
          </p>
        </section>
      ) : (
        <section aria-labelledby="featured-marketplace-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
            <div>
              <h2
                id="featured-marketplace-heading"
                className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
              >
                Featured packages
              </h2>
              <p className="mt-1 text-xs text-[var(--bo-muted)]">
                Published automations ready to install.
              </p>
            </div>
            <p className="font-mono text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
              {listings.length}
              {hasNextPage ? "+" : ""} available
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {listings.map((listing, index) => {
              const isLeadFeature = index === 0;
              return (
                <Link
                  key={listing.listingId}
                  to={marketplaceListingPath(listing.listingId, selectedScope)}
                  className={
                    isLeadFeature
                      ? "group relative flex min-h-72 flex-col overflow-hidden bg-[var(--bo-panel)] p-6 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent),0_16px_36px_rgba(var(--bo-accent-rgb),0.1)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96] md:p-7 lg:col-span-2"
                      : "group flex min-h-72 flex-col bg-[var(--bo-panel)] p-6 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
                  }
                >
                  {isLeadFeature ? (
                    <span
                      className="absolute top-0 left-0 h-1 w-full bg-[var(--bo-accent)]"
                      aria-hidden="true"
                    />
                  ) : null}

                  <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {isLeadFeature ? (
                        <span className="bg-[var(--bo-accent-bg)] px-2 py-1 font-mono text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-accent-fg)] uppercase shadow-[inset_0_0_0_1px_var(--bo-accent)]">
                          Featured
                        </span>
                      ) : null}
                      <span className="bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase shadow-[inset_0_0_0_1px_var(--bo-border)]">
                        {listing.category}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] font-semibold text-[var(--bo-muted-2)]">
                      v{listing.latestVersion}
                    </span>
                  </div>

                  <div className="mt-8 flex-1">
                    <h3
                      className={`font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)] transition-colors duration-150 ease-out group-hover:text-[var(--bo-accent-fg)] ${isLeadFeature ? "max-w-2xl text-3xl" : "text-2xl"}`}
                    >
                      {listing.name}
                    </h3>
                    <p
                      className={`mt-3 line-clamp-4 leading-6 text-pretty text-[var(--bo-muted)] ${isLeadFeature ? "max-w-2xl text-[15px]" : "text-sm"}`}
                    >
                      {listing.summary}
                    </p>
                    {listing.tags.length ? (
                      <div className="mt-5 flex flex-wrap gap-1.5">
                        {listing.tags.map((tag) => (
                          <span
                            key={tag}
                            className="font-mono text-[10px] text-[var(--bo-muted-2)]"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-7 flex items-end justify-between gap-4 border-t border-[color:var(--bo-border)] pt-4">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-[var(--bo-fg)]">
                        {listing.publisherName}
                      </p>
                      <p className="mt-1 font-mono text-[9px] text-[var(--bo-muted-2)]">
                        Published {formatPublishedAt(listing.publishedAt)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-accent-fg)] uppercase">
                      View package →
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {hasNextPage && nextCursor ? (
        <div className="flex justify-center pt-1">
          <Link
            to={marketplacePagePath(basePath, nextCursor)}
            className="bo-control-surface inline-flex min-h-11 items-center justify-center bg-[var(--bo-panel-2)] px-5 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
          >
            Show more automations →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
