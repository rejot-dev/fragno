import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import { ClientOnly } from "@/components/client-only";
import { marketplaceIngestionTargetScopeKey } from "@/fragno/automation/marketplace-ingestions";
import {
  getAutomationBrowserDatabase,
  type AutomationCollectionSource,
} from "@/fragno/automation/tanstack/browser-database";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import {
  summarizeInstalledWorkspace,
  type InstalledSourceSnapshot,
  type InstalledSourceSnapshots,
} from "./installed-state";
import type { MarketplaceLayoutContext } from "./layout-context";
import { marketplaceListingPath } from "./navigation";
import { toMarketplaceTargetScope } from "./scope";

export function meta() {
  return [{ title: "Installed · Marketplace" }];
}

export default function BackofficeMarketplaceInstalled() {
  const context = useOutletContext<MarketplaceLayoutContext>();

  return (
    <ClientOnly fallback={<InstalledLoading />}>
      <Suspense fallback={<InstalledLoading />}>
        <InstalledCollections context={context} />
      </Suspense>
    </ClientOnly>
  );
}

function InstalledCollections({ context }: { context: MarketplaceLayoutContext }) {
  const database = use(getAutomationBrowserDatabase());
  const targetScope = toMarketplaceTargetScope(context.selectedScope);
  const sourceOrganizationIds = useMemo(
    () => context.ingestionCollectionSources.map((source) => source.organizationId),
    [context.ingestionCollectionSources],
  );
  const sourceSetKey = JSON.stringify(sourceOrganizationIds);
  const [sourceSnapshots, setSourceSnapshots] = useState<InstalledSourceSnapshots>({
    sourceSetKey,
    byOrganizationId: {},
  });
  const effectiveSnapshots =
    sourceSnapshots.sourceSetKey === sourceSetKey ? sourceSnapshots.byOrganizationId : {};
  const { isLoading, showEmpty, totalRecordCount } = summarizeInstalledWorkspace({
    sourceOrganizationIds,
    snapshots: effectiveSnapshots,
  });
  const reportSourceSnapshot = useCallback(
    (organizationId: string, snapshot: InstalledSourceSnapshot) => {
      setSourceSnapshots((current) => {
        const currentSnapshots =
          current.sourceSetKey === sourceSetKey ? current.byOrganizationId : {};
        const existing = currentSnapshots[organizationId];
        if (existing?.status === snapshot.status && existing.recordCount === snapshot.recordCount) {
          return current;
        }
        return {
          sourceSetKey,
          byOrganizationId: {
            ...currentSnapshots,
            [organizationId]: snapshot,
          },
        };
      });
    },
    [sourceSetKey],
  );

  return (
    <div className="max-w-7xl space-y-4">
      {isLoading && totalRecordCount === 0 ? <InstalledLoading /> : null}
      {showEmpty ? <InstalledEmpty /> : null}
      {context.ingestionCollectionSources.map((collectionSource) => (
        <InstalledCollection
          key={collectionSource.organizationId}
          collections={database.collectionsFor(collectionSource.source)}
          collectionSource={collectionSource.source}
          organizationId={collectionSource.organizationId}
          organizationName={collectionSource.organizationName}
          selectedScope={context.selectedScope}
          targetScopeKey={marketplaceIngestionTargetScopeKey(targetScope)}
          onSnapshot={reportSourceSnapshot}
        />
      ))}
    </div>
  );
}

function InstalledCollection({
  collections,
  collectionSource,
  organizationId,
  organizationName,
  selectedScope,
  targetScopeKey,
  onSnapshot,
}: {
  collections: AutomationCollections;
  collectionSource: AutomationCollectionSource;
  organizationId: string;
  organizationName: string;
  selectedScope: MarketplaceLayoutContext["selectedScope"];
  targetScopeKey: string;
  onSnapshot: (organizationId: string, snapshot: InstalledSourceSnapshot) => void;
}) {
  const query = useLiveQuery(
    (builder) =>
      builder
        .from({ ingestion: collections.marketplaceIngestions })
        .where(({ ingestion }) => eq(ingestion.targetScopeKey, targetScopeKey))
        .orderBy(({ ingestion }) => ingestion.id, "asc"),
    [collections.marketplaceIngestions, targetScopeKey],
  );
  const ingestions = query.data ?? [];
  const sourceError = query.isError
    ? collections.marketplaceIngestions.utils.getLastError()
    : undefined;
  const sourceErrorMessage =
    sourceError instanceof Error
      ? sourceError.message
      : query.isError
        ? "Marketplace ingestion synchronization failed."
        : null;
  const sourceStatus: InstalledSourceSnapshot["status"] = query.isError
    ? "error"
    : query.isReady
      ? "ready"
      : "loading";

  useEffect(() => {
    onSnapshot(organizationId, {
      status: sourceStatus,
      recordCount: ingestions.length,
    });
  }, [ingestions.length, onSnapshot, organizationId, sourceStatus]);

  if (ingestions.length === 0 && !sourceErrorMessage) {
    return null;
  }

  return (
    <section className="space-y-3">
      {sourceErrorMessage ? (
        <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
          {ingestions.length > 0
            ? `Could not synchronize all marketplace ingestions from ${organizationName}: ${sourceErrorMessage}`
            : `Could not load marketplace ingestions from ${organizationName}: ${sourceErrorMessage}`}
        </div>
      ) : null}
      {ingestions.map((ingestion) => (
        <article
          key={`${collectionSource.scope.kind}:${ingestion.id}`}
          className="grid gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="border border-emerald-400/40 px-2 py-1 text-[9px] tracking-[0.16em] text-emerald-700 uppercase dark:text-emerald-200">
                Installed
              </span>
              <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                v{ingestion.version}
              </span>
            </div>
            <p className="mt-3 font-mono text-sm break-all text-[var(--bo-fg)]">
              {ingestion.listingId}
            </p>
            <p className="mt-2 font-mono text-[10px] text-[var(--bo-muted-2)]">
              {ingestion.targetScopeKey}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Link
              to={marketplaceListingPath(ingestion.listingId, selectedScope)}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              View listing
            </Link>
          </div>
        </article>
      ))}
    </section>
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

function InstalledLoading() {
  return (
    <div className="max-w-7xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      Loading marketplace ingestions…
      <noscript>
        <span className="mt-2 block text-red-700 dark:text-red-200">
          JavaScript is required to open installed marketplace data.
        </span>
      </noscript>
    </div>
  );
}
