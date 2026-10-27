import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  /** Where choosing the item goes. */
  to: string;
};

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
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
      {icon.kind === "image" ? (
        <img src={icon.url} alt="" loading="lazy" className="size-6 object-contain" />
      ) : (
        <Icon name={icon.name} className="size-5 text-[var(--bo-muted)]" />
      )}
    </span>
  );
}

function SourceCard({ item }: { item: SourceCatalogItem }) {
  return (
    <Link
      to={item.to}
      className="flex min-h-20 items-start gap-3 rounded-[4px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-3.5 transition-[border-color,background-color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
    >
      <SourceIcon icon={item.icon} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--bo-fg)]">{item.label}</span>
          {item.badge === null ? null : (
            <span className="shrink-0 rounded-[3px] bg-[var(--bo-selected-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--bo-accent)]">
              {item.badge}
            </span>
          )}
        </span>
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-pretty text-[var(--bo-muted)]">
          {item.description}
        </span>
      </span>
    </Link>
  );
}

/**
 * Every source a reader can choose from, grouped under broad categories. A search narrows the list,
 * and the category row jumps to a group. The toolbar and each group's heading stay in view while
 * the window scrolls, below whatever chrome the page sets `--bo-shell-top` to the height of.
 */
export function SourceCatalog({
  label,
  items,
}: {
  /** Names the catalog for screen readers, e.g. "Sources to connect". */
  label: string;
  items: readonly SourceCatalogItem[];
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(
    () => groupByPrimaryCategory(items.filter((item) => matchesQuery(item, normalizedQuery))),
    [items, normalizedQuery],
  );
  const total = groups.reduce((count, group) => count + group.items.length, 0);

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
    if (!sentinel || visibleCount >= total) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisibleCount((count) => count + PAGE_SIZE);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [visibleCount, total]);

  // A jump to a group that is not mounted yet first grows the list to include it.
  useEffect(() => {
    if (pendingJump === null) {
      return;
    }
    document
      .getElementById(sourceGroupElementId(pendingJump))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingJump(null);
  }, [pendingJump]);

  function jumpTo(groupId: string) {
    let end = 0;
    for (const group of groups) {
      end += group.items.length;
      if (group.id === groupId) {
        break;
      }
    }
    setVisibleCount((count) => Math.max(count, end));
    setPendingJump(groupId);
  }

  let remaining = visibleCount;
  return (
    <section aria-label={label} className="flex flex-col">
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
              onClick={() => {
                jumpTo(group.id);
              }}
              className="shrink-0 rounded-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1 text-xs font-semibold whitespace-nowrap text-[var(--bo-fg)] transition-[border-color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
            >
              {group.label}
              <span className="ml-1.5 text-[var(--bo-muted)] tabular-nums">
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
        groups.map((group) => {
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
              style={{ scrollMarginTop: `calc(var(--bo-shell-top, 0px) + ${toolbarHeight}px)` }}
            >
              <h3
                id={`${sourceGroupElementId(group.id)}-heading`}
                style={{ top: `calc(var(--bo-shell-top, 0px) + ${toolbarHeight}px)` }}
                className="sticky z-10 bg-[var(--bo-bg)] pt-5 pb-2 text-xs font-semibold tracking-wide text-[var(--bo-muted)] uppercase"
              >
                {group.label}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((item) => (
                  <SourceCard key={item.id} item={item} />
                ))}
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
