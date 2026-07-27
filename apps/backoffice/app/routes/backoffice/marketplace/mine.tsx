import { Form, Link } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
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
import type { Route } from "./+types/mine";
import { marketplaceListingManagePath } from "./navigation";

const updatedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const minePath = (input: {
  organizationId: string;
  status?: MarketplaceListingStatus;
  cursor?: string;
}) => {
  const search = new URLSearchParams({ organizationId: input.organizationId });
  if (input.status) {
    search.set("status", input.status);
  }
  if (input.cursor) {
    search.set("cursor", input.cursor);
  }
  return `/backoffice/marketplace/mine?${search.toString()}`;
};

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
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
  const requestedOrganizationId = url.searchParams.get("organizationId")?.trim();
  const organizationId =
    requestedOrganizationId ??
    me.activeOrganization?.organization.id ??
    organizations[0]?.id ??
    null;
  if (!organizationId || !organizations.some(({ id }) => id === organizationId)) {
    throw new Response("Publisher organisation was not found.", { status: 404 });
  }

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
      ownerScope: { kind: "org", orgId: organizationId },
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
    ownerScope: { kind: "org", orgId: organizationId },
    status,
    cursor,
  });

  return {
    organizations,
    organizationId,
    status: status ?? null,
    ...page,
  };
}

export function meta() {
  return [{ title: "My Marketplace Listings" }];
}

export default function BackofficeMarketplaceMine({ loaderData }: Route.ComponentProps) {
  const { organizations, organizationId, status, listings, hasNextPage, nextCursor } = loaderData;

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Marketplace", to: "/backoffice/marketplace" },
          { label: "My listings" },
        ]}
        eyebrow="Publisher workspace"
        title="Manage marketplace listings."
        description="Review private drafts, publish immutable versions, update listing metadata, or archive entries from the public catalog."
        actions={
          <Link
            to="/backoffice/marketplace/publish"
            className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
          >
            New draft
          </Link>
        }
      />

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
        <Form
          method="get"
          className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
        >
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Publisher
            </span>
            <select
              name="organizationId"
              defaultValue={organizationId}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
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
          {listings.map((listing) => (
            <Link
              key={listing.listingId}
              to={marketplaceListingManagePath({
                listingId: listing.listingId,
                organizationId,
              })}
              className="grid gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 transition-colors hover:border-[color:var(--bo-accent)] hover:bg-[var(--bo-panel-2)] md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
            >
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
                <p className="mt-1 font-mono text-xs text-[var(--bo-muted)]">{listing.category}</p>
              </div>
              <div className="text-left md:text-right">
                <p className="text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                  Updated
                </p>
                <p className="mt-1 text-sm text-[var(--bo-fg)]">
                  {updatedAtFormatter.format(new Date(listing.updatedAt))}
                </p>
              </div>
            </Link>
          ))}
        </section>
      )}

      {hasNextPage && nextCursor ? (
        <div className="flex justify-end">
          <Link
            to={minePath({
              organizationId,
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
