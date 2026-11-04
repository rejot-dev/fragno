import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Link } from "react-router";

import { Icon, type IconName } from "../icon";
import { Input } from "./input";

/** A logo the source publishes, or a symbol for a source that has none. */
export type SourceCatalogIcon = { kind: "image"; url: string } | { kind: "symbol"; name: IconName };

export type SourceCatalogItem = {
  id: string;
  label: string;
  description: string;
  icon: SourceCatalogIcon;
  /** Most specific first: the item is listed under its first category and found by all of them. */
  categories: readonly { id: string; label: string }[];
  /** A short state such as "Connected", or null. */
  badge: string | null;
  /** Where choosing the item goes; for the expanded item, where closing it goes. */
  to: string;
};

/** The item opened in place, and what it shows under its card. */
export type SourceCatalogExpansion = { id: string; content: ReactNode };

type SourceCatalogGroup = {
  id: string;
  label: string;
  items: SourceCatalogItem[];
};

const OTHER_GROUP = { id: "other", label: "Other" };
// Items mounted per step. A catalog can list well over a thousand sources, so the list grows as the
// reader nears its end instead of mounting every card at once.
const PAGE_SIZE = 60;

function matchesQuery(item: SourceCatalogItem, query: string): boolean {
  if (query === "") {
    return true;
  }
  return [item.label, item.description, ...item.categories.map((category) => category.label)].some(
    (text) => text.toLocaleLowerCase().includes(query),
  );
}

/** Groups items by their primary category, alphabetically, with uncategorized items last. */
function groupByPrimaryCategory(items: readonly SourceCatalogItem[]): SourceCatalogGroup[] {
  const groups = new Map<string, SourceCatalogGroup>();
  for (const item of items) {
    const category = item.categories[0] ?? OTHER_GROUP;
    const group = groups.get(category.id) ?? { ...category, items: [] };
    group.items.push(item);
    groups.set(category.id, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) =>
      a.id === OTHER_GROUP.id ? 1 : b.id === OTHER_GROUP.id ? -1 : a.label.localeCompare(b.label),
    );
}

function SourceIcon({ icon }: { icon: SourceCatalogIcon }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)]">
      {icon.kind === "image" ? (
        <img src={icon.url} alt="" loading="lazy" className="size-6 object-contain" />
      ) : (
        <Icon name={icon.name} className="size-5 text-[var(--bo-muted)]" />
      )}
    </span>
  );
}

const CARD_LINK_FOCUS =
  "focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none";

// Cards and categories look like the sidebar's destinations: flat at rest, raised to its selected
// surface on hover, and selected while open or chosen.
const SELECTED_SURFACE =
  "border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)]";
const RESTING_SURFACE =
  "border-transparent hover:border-[color:var(--bo-selected-border)] hover:bg-[var(--bo-selected-bg)]";

function SourceSummary({ item }: { item: SourceCatalogItem }) {
  return (
    <>
      <SourceIcon icon={item.icon} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--bo-fg)]">{item.label}</span>
          {item.badge === null ? null : (
            <span className="shrink-0 rounded-[3px] bg-[var(--bo-accent-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--bo-accent-fg)]">
              {item.badge}
            </span>
          )}
        </span>
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-pretty text-[var(--bo-muted)]">
          {item.description}
        </span>
      </span>
    </>
  );
}

function SourceCard({ item }: { item: SourceCatalogItem }) {
  return (
    <Link
      to={item.to}
      preventScrollReset
      aria-expanded={false}
      className={`flex min-h-20 items-start gap-3 rounded-[4px] border px-4 py-3.5 transition-[border-color,background-color,box-shadow] duration-150 ease-out ${RESTING_SURFACE} ${CARD_LINK_FOCUS}`}
    >
      <SourceSummary item={item} />
    </Link>
  );
}

/** The open item: its card keeps its place and size, and holds its content below the summary. */
function ExpandedSourceCard({
  item,
  content,
  ref,
}: {
  item: SourceCatalogItem;
  content: ReactNode;
  ref: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className={`flex scroll-mt-[calc(var(--bo-shell-top,0px)+8rem)] scroll-mb-4 flex-col rounded-[4px] border ${SELECTED_SURFACE}`}
    >
      <Link
        to={item.to}
        preventScrollReset
        aria-expanded
        className={`flex items-start gap-3 rounded-[4px] px-4 pt-3.5 pb-3 ${CARD_LINK_FOCUS}`}
      >
        <SourceSummary item={item} />
      </Link>
      {/* Set in the summary's text column, past the size-10 icon and its gap-3, so the content
          reads as part of the source and lines up with its name. */}
      <div className="pr-4 pb-4 pl-17">{content}</div>
    </div>
  );
}

/**
 * Every source a reader can choose from, grouped under broad categories. A search narrows the list,
 * and choosing a category in the row below it shows only that group; choosing it again clears it.
 * The `expanded` item opens in place: its card holds its content below its summary.
 * The toolbar and each group's heading stay in view while the window scrolls, below whatever
 * chrome the page sets `--bo-shell-top` to the height of.
 */
export function SourceCatalog({
  label,
  items,
  expanded,
}: {
  /** Names the catalog for screen readers, e.g. "Sources to connect". */
  label: string;
  items: readonly SourceCatalogItem[];
  expanded: SourceCatalogExpansion | null;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(
    () => groupByPrimaryCategory(items.filter((item) => matchesQuery(item, normalizedQuery))),
    [items, normalizedQuery],
  );
  // A search that leaves the chosen category empty hides its chip, so the filter lapses with it.
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const shownGroups = selectedGroup === null ? groups : [selectedGroup];
  const total = shownGroups.reduce((count, group) => count + group.items.length, 0);
  const expansionRef = useRef<HTMLDivElement>(null);
  const expandedId = expanded?.id ?? null;

  // An item opened from a link into the page, such as a provider's return, may sit past what is
  // mounted; the list grows to include it.
  const expandedIndex =
    expandedId === null
      ? -1
      : shownGroups.flatMap((group) => group.items).findIndex((item) => item.id === expandedId);
  const mountedCount = Math.max(visibleCount, expandedIndex + 1);

  useEffect(() => {
    if (expandedId !== null) {
      expansionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [expandedId]);

  // Group headings stick just below the toolbar, whose height follows its wrapping content.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setToolbarHeight(toolbar.offsetHeight);
    });
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || mountedCount >= total) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisibleCount(mountedCount + PAGE_SIZE);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [mountedCount, total]);

  function toggleGroup(groupId: string) {
    setSelectedGroupId(selectedGroup?.id === groupId ? null : groupId);
    setVisibleCount(PAGE_SIZE);
    // A shorter list would leave a reader scrolled far down at its end; start them at its top.
    const catalog = catalogRef.current;
    if (catalog && catalog.getBoundingClientRect().top < 0) {
      catalog.scrollIntoView({ block: "start" });
    }
  }

  let remaining = mountedCount;
  return (
    <section
      ref={catalogRef}
      aria-label={label}
      className="flex scroll-mt-[var(--bo-shell-top,0px)] flex-col"
    >
      <div
        ref={toolbarRef}
        className="sticky top-[var(--bo-shell-top,0px)] z-20 flex flex-col gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-bg)] pt-1 pb-3"
      >
        <Input
          type="search"
          aria-label="Search sources"
          placeholder="Search sources, like Gmail or Linear"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleCount(PAGE_SIZE);
          }}
          className="w-full"
        />
        <nav aria-label="Categories" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-pressed={group.id === selectedGroup?.id}
              onClick={() => {
                toggleGroup(group.id);
              }}
              className={`shrink-0 rounded-[4px] border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-[border-color,background-color,box-shadow,color] duration-150 ease-out ${CARD_LINK_FOCUS} ${
                group.id === selectedGroup?.id
                  ? `${SELECTED_SURFACE} text-[var(--bo-fg)]`
                  : `${RESTING_SURFACE} text-[var(--bo-muted)] hover:text-[var(--bo-fg)]`
              }`}
            >
              {group.label}
              <span className="ml-1.5 text-[var(--bo-muted-2)] tabular-nums">
                {group.items.length}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {total === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--bo-muted)]">
          No source matches “{query.trim()}”.
        </p>
      ) : (
        shownGroups.map((group) => {
          if (remaining <= 0) {
            return null;
          }
          const shown = group.items.slice(0, remaining);
          remaining -= shown.length;
          return (
            <section
              key={group.id}
              id={sourceGroupElementId(group.id)}
              aria-labelledby={`${sourceGroupElementId(group.id)}-heading`}
            >
              <h3
                id={`${sourceGroupElementId(group.id)}-heading`}
                style={{ top: `calc(var(--bo-shell-top, 0px) + ${toolbarHeight}px)` }}
                className="sticky z-10 bg-[var(--bo-bg)] px-4 pt-5 pb-2 text-xs font-semibold text-[var(--bo-muted-2)]"
              >
                {group.label}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((item) =>
                  expanded !== null && item.id === expanded.id ? (
                    <ExpandedSourceCard
                      key={item.id}
                      item={item}
                      content={expanded.content}
                      ref={expansionRef}
                    />
                  ) : (
                    <SourceCard key={item.id} item={item} />
                  ),
                )}
              </div>
            </section>
          );
        })
      )}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
    </section>
  );
}

function sourceGroupElementId(groupId: string): string {
  return `source-group-${groupId}`;
}
