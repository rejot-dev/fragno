import { Form, Link, useOutletContext } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { MARKETPLACE_CATEGORIES, marketplaceCategorySchema } from "@/fragno/marketplace/contracts";
import {
  decodeMarketplaceListingCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/browse";
import type { MarketplaceLayoutContext } from "./layout-context";
import { marketplaceListingPath } from "./navigation";

const marketplacePagePath = (input: { basePath: string; category?: string; cursor?: string }) => {
  const search = new URLSearchParams();
  if (input.category) {
    search.set("category", input.category);
  }
  if (input.cursor) {
    search.set("cursor", input.cursor);
  }
  const query = search.toString();
  return query ? `${input.basePath}?${query}` : input.basePath;
};

const publishedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const formatPublishedAt = (value: string) => publishedAtFormatter.format(new Date(value));

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const categoryValue = url.searchParams.get("category")?.trim() || undefined;
  const categoryResult = marketplaceCategorySchema.optional().safeParse(categoryValue);
  if (!categoryResult.success) {
    throw new Response("Invalid marketplace category.", { status: 400 });
  }
  const category = categoryResult.data;
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  try {
    decodeMarketplaceListingCursor({ encodedCursor: cursor, category });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
  const page = await marketplace.listPublishedListings({ category, cursor });
  return { basePath: url.pathname, category: category ?? null, ...page };
}

export function meta() {
  return [
    { title: "Automation Marketplace" },
    {
      name: "description",
      content: "Browse and publish versioned automation packages.",
    },
  ];
}

export default function BackofficeMarketplaceBrowse({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();
  const { basePath, category, listings, nextCursor, hasNextPage } = loaderData;

  return (
    <div className="space-y-4">
      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
        <Form method="get" className="flex flex-col gap-3 md:flex-row md:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Category
            </span>
            <select
              name="category"
              defaultValue={category ?? ""}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            >
              <option value="">All categories</option>
              {MARKETPLACE_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Apply filter
          </button>
        </Form>
      </section>

      {listings.length === 0 ? (
        <section className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-6 py-16 text-center">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Empty shelf
          </p>
          <h2 className="mt-3 text-2xl font-semibold text-[var(--bo-fg)]">
            No published automations{category ? ` in ${category}` : " yet"}.
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--bo-muted)]">
            Publish a JSON automation package to establish the first immutable version.
          </p>
        </section>
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {listings.map((listing) => (
            <Link
              key={listing.listingId}
              to={marketplaceListingPath(listing.listingId, selectedScope)}
              className="group flex min-h-56 flex-col border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 transition-[border-color,transform,background-color] hover:-translate-y-0.5 hover:border-[color:var(--bo-accent)] hover:bg-[var(--bo-panel-2)]"
            >
              <div className="flex items-start justify-between gap-4">
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[9px] tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                  {listing.category}
                </span>
                <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                  v{listing.latestVersion}
                </span>
              </div>

              <div className="mt-6 flex-1">
                <h2 className="text-xl font-semibold tracking-tight text-[var(--bo-fg)] group-hover:text-[var(--bo-accent-fg)]">
                  {listing.name}
                </h2>
                <p className="mt-2 line-clamp-4 text-sm leading-6 text-[var(--bo-muted)]">
                  {listing.summary}
                </p>
                <p className="mt-3 text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                  By {listing.publisherName}
                </p>
                {listing.tags.length ? (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {listing.tags.map((tag) => (
                      <span key={tag} className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-6 border-t border-[color:var(--bo-border)] pt-3 text-right text-[10px] text-[var(--bo-muted-2)]">
                {formatPublishedAt(listing.publishedAt)}
              </div>
            </Link>
          ))}
        </section>
      )}

      {hasNextPage && nextCursor ? (
        <div className="flex justify-end">
          <Link
            to={marketplacePagePath({
              basePath,
              category: category ?? undefined,
              cursor: nextCursor,
            })}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Next shelf →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
