import { Form, Link } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  marketplaceListingStatusSchema,
  type MarketplaceListingStatus,
} from "@/fragno/marketplace/contracts";
import {
  decodeMarketplaceOwnedListingCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { fetchAutomationProjects } from "../automations/data.server";
import type { Route } from "./+types/my-listings";
import { marketplaceListingManagePath, marketplaceListingPath } from "./navigation";
import { marketplaceScopeFromRouteParams, resolveMarketplaceUiScope } from "./scope";

const updatedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const minePath = (input: {
  basePath: string;
  status?: MarketplaceListingStatus;
  cursor?: string;
}) => {
  const search = new URLSearchParams();
  if (input.status) {
    search.set("status", input.status);
  }
  if (input.cursor) {
    search.set("cursor", input.cursor);
  }
  const query = search.toString();
  return query ? `${input.basePath}?${query}` : input.basePath;
};

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const routeScope = marketplaceScopeFromRouteParams(params);
  const organizations = me.organizations.map(({ organization }) => organization);
  const projectOrgId =
    routeScope.kind === "org" || routeScope.kind === "project"
      ? routeScope.orgId
      : (me.activeOrganization?.organization.id ?? organizations[0]?.id ?? null);
  if (!projectOrgId) {
    throw new Response("Publisher scope was not found.", { status: 404 });
  }
  const projectsResult = await fetchAutomationProjects(context, projectOrgId);
  if (routeScope.kind === "project" && projectsResult.projectsError) {
    throw new Response(projectsResult.projectsError, { status: 502 });
  }
  const selectedScope = resolveMarketplaceUiScope({
    params,
    organisations: organizations,
    projects: projectsResult.projects,
    user: me.user,
  });

  const statusResult = marketplaceListingStatusSchema
    .optional()
    .safeParse(url.searchParams.get("status")?.trim() || undefined);
  if (!statusResult.success) {
    throw new Response("Invalid marketplace listing status.", { status: 400 });
  }
  const status = statusResult.data;
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

  const marketplace = context.get(BackofficeWorkerContext).runtime.objects.marketplace.singleton();
  const page = await marketplace.listOwnedListings({
    ownerScope: routeScope,
    status,
    cursor,
  });

  return {
    basePath: url.pathname,
    selectedScope,
    status: status ?? null,
    ...page,
  };
}

export function meta() {
  return [{ title: "My Marketplace Listings" }];
}

export default function BackofficeMarketplaceMyListings({ loaderData }: Route.ComponentProps) {
  const { basePath, selectedScope, status, listings, hasNextPage, nextCursor } = loaderData;
  const organizationId = selectedScope.kind === "org" ? selectedScope.orgId : null;

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
          {organizationId ? (
            <Link
              to={`/backoffice/marketplace/publish?ownerOrgId=${encodeURIComponent(organizationId)}`}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              New draft
            </Link>
          ) : null}
        </div>
        <Form method="get" className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Status
            </span>
            <select
              name="status"
              defaultValue={status ?? ""}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <button
            type="submit"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Apply
          </button>
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
            const listingPath = organizationId
              ? marketplaceListingManagePath({ listingId: listing.listingId, organizationId })
              : listing.latestPublishedVersion
                ? marketplaceListingPath(listing.listingId, selectedScope)
                : null;
            const content = (
              <>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={listing.status} />
                    <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                      {listing.latestPublishedVersion
                        ? `latest v${listing.latestPublishedVersion}`
                        : "not published"}
                    </span>
                  </div>
                  <h2 className="mt-3 text-xl font-semibold text-[var(--bo-fg)]">{listing.name}</h2>
                  <p className="mt-1 font-mono text-xs text-[var(--bo-muted)]">
                    {listing.category}
                  </p>
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
          <Link
            to={minePath({
              basePath,
              status: status ?? undefined,
              cursor: nextCursor,
            })}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Next page →
          </Link>
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
