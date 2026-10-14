import type { MarketplaceListing } from "@fragno-dev/backoffice-api/v0/marketplace";
import { Link } from "react-router";

const publishedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Featured views lead with the highest-priority listing and show curator notes; catalog views mark
 * featured listings with a badge instead.
 */
export type MarketplaceListingCardPresentation =
  | { kind: "featured"; lead: boolean; note: string | null }
  | { kind: "catalog" };

/** Renders one published listing as a link card; the lead card spans two grid columns. */
export function MarketplaceListingCard({
  listing,
  to,
  presentation,
}: {
  listing: MarketplaceListing;
  to: string;
  presentation: MarketplaceListingCardPresentation;
}) {
  const featured = presentation.kind === "featured" && presentation.lead;
  const note = presentation.kind === "featured" ? presentation.note : null;
  return (
    <Link
      to={to}
      className={
        featured
          ? "group relative flex min-h-72 flex-col overflow-hidden bg-[var(--bo-panel)] p-6 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent),0_16px_36px_rgba(var(--bo-accent-rgb),0.1)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96] md:p-7 lg:col-span-2"
          : "group flex min-h-72 flex-col bg-[var(--bo-panel)] p-6 shadow-[inset_0_0_0_1px_var(--bo-border)] transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:shadow-[inset_0_0_0_1px_var(--bo-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
      }
    >
      {featured ? (
        <span
          className="absolute top-0 left-0 h-1 w-full bg-[var(--bo-accent)]"
          aria-hidden="true"
        />
      ) : null}

      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {presentation.kind === "catalog" && listing.featured ? (
            <span className="bg-[var(--bo-accent-bg)] px-2 py-1 text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-accent-fg)] uppercase shadow-[inset_0_0_0_1px_var(--bo-accent)]">
              Featured
            </span>
          ) : null}
          <span className="bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase shadow-[inset_0_0_0_1px_var(--bo-border)]">
            {listing.category}
          </span>
        </div>
        <span className="shrink-0 text-[10px] font-semibold text-[var(--bo-muted-2)]">
          v{listing.latestVersion}
        </span>
      </div>

      <div className="mt-8 flex-1">
        <h3
          className={`font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)] transition-colors duration-150 ease-out group-hover:text-[var(--bo-accent-fg)] ${featured ? "max-w-2xl text-3xl" : "text-2xl"}`}
        >
          {listing.name}
        </h3>
        <p
          className={`mt-3 line-clamp-4 leading-6 text-pretty text-[var(--bo-muted)] ${featured ? "max-w-2xl text-[15px]" : "text-sm"}`}
        >
          {listing.summary}
        </p>
        {note ? (
          <p className="mt-4 border-l-2 border-[color:var(--bo-accent)] pl-3 text-xs leading-5 text-pretty text-[var(--bo-fg)]">
            {note}
          </p>
        ) : null}
        {listing.tags.length ? (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {listing.tags.map((tag) => (
              <span key={tag} className="text-[10px] text-[var(--bo-muted-2)]">
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
          <p className="mt-1 text-[9px] text-[var(--bo-muted-2)]">
            Published {publishedAtFormatter.format(new Date(listing.publishedAt))}
          </p>
        </div>
        <span className="shrink-0 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-accent-fg)] uppercase">
          View package →
        </span>
      </div>
    </Link>
  );
}
