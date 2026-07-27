import { Link, useLocation } from "react-router";

import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  decodeMarketplacePublishedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/detail";
import {
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRefSchema,
} from "./navigation";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const formatDateTime = (value: string) => dateTimeFormatter.format(new Date(value));

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

  const versionCursor = url.searchParams.get("versionCursor")?.trim() || undefined;
  try {
    decodeMarketplacePublishedVersionCursor({
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
  const detail = await marketplace.getPublishedListing({
    listingId: listingIdResult.data,
    versionCursor,
  });
  if (!detail) {
    throw new Response("Not Found", { status: 404 });
  }

  const manageableOrganization = me.organizations.find(
    ({ organization }) =>
      marketplaceListingId({
        ownerScope: { kind: "org", orgId: organization.id },
        slug: detail.listing.slug,
      }) === detail.listing.listingId,
  );
  return {
    ...detail,
    manageOrganizationId: manageableOrganization?.organization.id ?? null,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.listing.name} · Marketplace` : "Marketplace" }];
}

export default function BackofficeMarketplaceDetail({ loaderData }: Route.ComponentProps) {
  const { listing, versions, manageOrganizationId, nextVersionCursor, hasNextVersionPage } =
    loaderData;
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const publishedVersionParam = search.get("published");
  const publishedVersion = versions.some(({ version }) => version === publishedVersionParam)
    ? publishedVersionParam
    : null;
  const reusedPublication = publishedVersion !== null && search.get("reused") === "1";

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Marketplace", to: "/backoffice/marketplace" },
          { label: listing.name },
        ]}
        eyebrow={listing.category}
        title={listing.name}
        description={listing.summary}
        actions={
          manageOrganizationId ? (
            <Link
              to={marketplaceListingManagePath({
                listingId: listing.listingId,
                organizationId: manageOrganizationId,
              })}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Manage
            </Link>
          ) : null
        }
      />

      {publishedVersion ? (
        <div className="border border-emerald-400/40 bg-emerald-500/12 p-4 text-sm text-emerald-700 dark:text-emerald-200">
          {reusedPublication
            ? `Version ${publishedVersion} was already published.`
            : `Version ${publishedVersion} was published successfully.`}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <FormContainer
          eyebrow="About"
          title="Automation description"
          description="This marketplace entry currently contains metadata only."
        >
          <p className="max-w-3xl text-sm leading-7 whitespace-pre-wrap text-[var(--bo-muted)]">
            {listing.description}
          </p>
          {listing.tags.length ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {listing.tags.map((tag) => (
                <span
                  key={tag}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[10px] text-[var(--bo-muted)]"
                >
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
        </FormContainer>

        <aside className="space-y-4">
          <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Latest release
            </p>
            <dl className="mt-4 space-y-3 text-sm">
              <MetadataRow label="Version" value={listing.latestVersion} mono />
              <MetadataRow label="Published" value={formatDateTime(listing.publishedAt)} />
              <MetadataRow label="Publisher" value={listing.publisherName} />
            </dl>
          </section>

          <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Version history
            </p>
            <div className="mt-3 space-y-2">
              {versions.map((version) => (
                <div
                  key={version.version}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                >
                  <p className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
                    v{version.version}
                  </p>
                  <p className="mt-1 text-[10px] text-[var(--bo-muted-2)]">
                    {formatDateTime(version.publishedAt)}
                  </p>
                </div>
              ))}
            </div>
            {hasNextVersionPage && nextVersionCursor ? (
              <Link
                to={`${marketplaceListingPath(listing.listingId)}?versionCursor=${encodeURIComponent(nextVersionCursor)}`}
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

function MetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-[var(--bo-muted-2)]">{label}</dt>
      <dd
        className={
          mono
            ? "text-right font-mono text-xs break-all text-[var(--bo-fg)]"
            : "text-right text-[var(--bo-fg)]"
        }
      >
        {value}
      </dd>
    </div>
  );
}
