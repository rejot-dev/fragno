import { Link, useOutletContext } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  MARKETPLACE_LATEST_VERSIONS_MAX_IDS,
  type MarketplaceLatestPublishedVersions,
} from "@/fragno/marketplace/contracts";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/installed";
import type { MarketplaceLayoutContext } from "./layout-context";
import { marketplaceListingPath } from "./navigation";
import { marketplaceScopeFromRouteParams } from "./scope";

export function meta() {
  return [{ title: "Installed · Marketplace" }];
}

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const targetScope = marketplaceScopeFromRouteParams(params);
  if (targetScope.kind === "user" && targetScope.userId !== me.user.id) {
    throw new Response("Not Found", { status: 404 });
  }
  if (
    targetScope.kind !== "user" &&
    !me.organizations.some(({ organization }) => organization.id === targetScope.orgId)
  ) {
    throw new Response("Not Found", { status: 404 });
  }

  const ingestionOrganizations =
    targetScope.kind === "user"
      ? me.organizations.map(({ organization }) => organization)
      : me.organizations
          .map(({ organization }) => organization)
          .filter((organization) => organization.id === targetScope.orgId);
  const runtime = context.get(BackofficeWorkerContext).runtime;
  const ingestionPages = await Promise.all(
    ingestionOrganizations.map(async (organization) => ({
      organization,
      ingestions: await runtime.objects.automations
        .forOrg(organization.id)
        .listMarketplaceIngestions({ targetScope }),
    })),
  );
  const ingestions = ingestionPages.flatMap(({ organization, ingestions: records }) =>
    records.map((ingestion) => ({
      ...ingestion,
      organizationId: organization.id,
      organizationName: organization.name ?? organization.id,
    })),
  );
  const listingIds = Array.from(new Set(ingestions.map((ingestion) => ingestion.listingId)));
  const latestPublishedVersions: MarketplaceLatestPublishedVersions = {};
  const marketplace = runtime.objects.marketplace.singleton();
  for (let offset = 0; offset < listingIds.length; offset += MARKETPLACE_LATEST_VERSIONS_MAX_IDS) {
    const listingIdBatch = listingIds.slice(offset, offset + MARKETPLACE_LATEST_VERSIONS_MAX_IDS);
    Object.assign(
      latestPublishedVersions,
      await marketplace.getLatestPublishedVersions({ listingIds: listingIdBatch }),
    );
  }

  return {
    ingestions: ingestions.map((ingestion) => {
      const latestVersion = latestPublishedVersions[ingestion.listingId] ?? null;
      return {
        ...ingestion,
        latestVersion,
        outOfDate: latestVersion !== null && ingestion.version !== latestVersion,
      };
    }),
  };
}

export default function BackofficeMarketplaceInstalled({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();

  if (loaderData.ingestions.length === 0) {
    return <InstalledEmpty />;
  }

  return (
    <div className="max-w-7xl space-y-3">
      {loaderData.ingestions.map((ingestion) => (
        <article
          key={`${ingestion.organizationId}:${ingestion.id}`}
          className="grid gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  ingestion.outOfDate
                    ? "border border-amber-400/40 px-2 py-1 text-[9px] tracking-[0.16em] text-amber-700 uppercase dark:text-amber-200"
                    : "border border-emerald-400/40 px-2 py-1 text-[9px] tracking-[0.16em] text-emerald-700 uppercase dark:text-emerald-200"
                }
              >
                {ingestion.outOfDate ? "Update available" : "Installed"}
              </span>
              <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                Installed v{ingestion.version}
              </span>
              <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                Latest {ingestion.latestVersion ? `v${ingestion.latestVersion}` : "unavailable"}
              </span>
            </div>
            <p className="mt-3 font-mono text-sm break-all text-[var(--bo-fg)]">
              {ingestion.listingId}
            </p>
            <p className="mt-2 font-mono text-[10px] text-[var(--bo-muted-2)]">
              {ingestion.organizationName} · {ingestion.targetScopeKey}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Link
              to={marketplaceListingPath(ingestion.listingId, selectedScope)}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              {ingestion.outOfDate ? "Review update" : "View listing"}
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}

function InstalledEmpty() {
  return (
    <section className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-6 py-16 text-center">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        Nothing installed
      </p>
      <h2 className="mt-3 text-2xl font-semibold text-[var(--bo-fg)]">
        This workspace has no marketplace ingestions yet.
      </h2>
    </section>
  );
}
