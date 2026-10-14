import "@fragno-private/design-system/components.css";

import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { Link } from "react-router";

import {
  decodeMarketplacePublishedVersionCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { resolveMarketplaceListingRoute } from "../backoffice/marketplace/listing-route.server";
import { marketplaceInstallEntryPath } from "../backoffice/marketplace/navigation";
import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";
import type { Route } from "./+types/listing";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const formatDate = (value: string) => dateFormatter.format(new Date(value));

// Public pages expose listing metadata only; package files stay behind Backoffice sign-in.
export async function loader({ params, context, url }: Route.LoaderArgs) {
  const objects = context.get(BackofficeWorkerContext).runtime.objects;
  const { listingId, listingRef } = await resolveMarketplaceListingRoute(objects, params);
  const versionCursor = url.searchParams.get("versionCursor")?.trim() || undefined;
  try {
    decodeMarketplacePublishedVersionCursor({
      encodedCursor: versionCursor,
      listingId,
    });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const detail = await objects.marketplace
    .singleton()
    .commands.getPublishedListing({ listingId, versionCursor });
  if (!detail) {
    throw new Response("Not Found", { status: 404 });
  }
  return { ...detail, listingRef };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [{ title: "Marketplace · ReJot Backoffice" }];
  }
  const title = `${loaderData.listing.name} · Marketplace`;
  return [
    { title },
    { name: "description", content: loaderData.listing.summary },
    { property: "og:title", content: title },
    { property: "og:description", content: loaderData.listing.summary },
  ];
}

export default function PublicMarketplaceListing({ loaderData }: Route.ComponentProps) {
  const { listing, versions, nextVersionCursor, hasNextVersionPage } = loaderData;

  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 pt-10 pb-24 sm:px-8 lg:px-12 lg:pt-14">
        <Link
          to="/marketplace"
          className="inline-flex min-h-10 items-center text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted)] uppercase no-underline hover:text-[var(--bo-fg)]"
        >
          ← Marketplace
        </Link>

        <header className="bo-panel-surface mt-4 bg-[var(--bo-panel)] p-6 md:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="bo-product-code">PKG</span>
                <p className="text-[10px] tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                  {listing.category}
                </p>
              </div>
              <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-balance text-[var(--bo-fg)] md:text-4xl">
                {listing.name}
              </h1>
              <p className="mt-3 max-w-2xl text-[15px] leading-7 text-pretty text-[var(--bo-muted)]">
                {listing.summary}
              </p>
              {listing.tags.length ? (
                <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1">
                  {listing.tags.map((tag) => (
                    <span key={tag} className="font-mono text-xs text-[var(--bo-muted-2)]">
                      #{tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <ButtonLink
              to={marketplaceInstallEntryPath(loaderData.listingRef)}
              variant="solid"
              className="shrink-0 self-start"
            >
              Install in Backoffice
            </ButtonLink>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--bo-muted)]">
            <span>
              Published by{" "}
              <span className="font-medium text-[var(--bo-fg)]">{listing.publisherName}</span>
            </span>
            <span>Updated {formatDate(listing.updatedAt)}</span>
            <span className="font-mono text-[var(--bo-fg)]">v{listing.latestVersion}</span>
          </div>
        </header>

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section
            aria-labelledby="public-listing-about"
            className="bo-panel-surface min-w-0 bg-[var(--bo-panel)] p-6 md:p-8"
          >
            <h2
              id="public-listing-about"
              className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
            >
              About
            </h2>
            <p className="mt-3 text-sm leading-7 text-pretty whitespace-pre-line text-[var(--bo-muted)]">
              {listing.description}
            </p>
          </section>

          <section
            aria-labelledby="public-listing-releases"
            className="bo-panel-surface bg-[var(--bo-panel)] p-6"
          >
            <h2
              id="public-listing-releases"
              className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
            >
              Releases
            </h2>
            <ul className="mt-3 divide-y divide-[color:var(--bo-border)]">
              {versions.map((version) => (
                <li
                  key={version.version}
                  className="flex min-h-12 items-center justify-between gap-4 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-xs font-semibold text-[var(--bo-fg)]">
                      v{version.version}
                    </span>
                    <span className="mt-1 block text-[10px] text-[var(--bo-muted-2)]">
                      {formatDate(version.publishedAt)}
                    </span>
                  </span>
                  {version.version === listing.latestVersion ? (
                    <BackofficeStatusLight tone="info">Latest</BackofficeStatusLight>
                  ) : null}
                </li>
              ))}
            </ul>
            {hasNextVersionPage && nextVersionCursor ? (
              <Link
                to={`?${new URLSearchParams({ versionCursor: nextVersionCursor })}`}
                preventScrollReset
                className="mt-3 flex min-h-10 items-center justify-center border-t border-[color:var(--bo-border)] pt-2 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted)] uppercase hover:text-[var(--bo-fg)]"
              >
                Older releases →
              </Link>
            ) : null}
          </section>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
