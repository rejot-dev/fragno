import { Popover } from "@base-ui/react/popover";
import { Suspense, use, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";
import { tabMenuPopupClassName, tabMenuTitleClassName } from "./tab-menu-class-names";
import { underlineTabClassName } from "./underline-tab-class-name";

export type TabPinMenuItem = {
  id: string;
  label: string;
  /** Muted context before the label, such as the folder a file sits in. */
  detail: string | null;
  to: string;
};

/** What the menu lists once its items arrive, or why they could not be read. */
export type TabPinMenuItems =
  | { kind: "listed"; items: readonly TabPinMenuItem[] }
  | { kind: "failed"; message: string };

type TabPinMenuListProps = {
  /** Marks each item and the empty state. */
  icon: IconName;
  items: Promise<TabPinMenuItems>;
  /** The item already open, which the menu marks instead of linking. */
  activeId: string | null;
  pinnedIds: readonly string[];
  onPinnedChange: (item: TabPinMenuItem, pinned: boolean) => void;
  empty: { title: string; description: ReactNode };
};

/**
 * A "+" at the end of an underline tab row that lists views the row does not hold by default, such
 * as files a person can open. Each opens from its row, and pinning one keeps it in the row as a
 * tab; the row owns which are pinned. Pass it as the row's `trailing`. The items arrive while the
 * row is already in use; the menu waits for them only once it opens.
 */
export function TabPinMenu({
  title,
  ariaLabel,
  loading,
  ...list
}: TabPinMenuListProps & {
  title: string;
  ariaLabel: string;
  loading: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={ariaLabel}
        className={cn(
          underlineTabClassName("idle"),
          "data-[popup-open]:text-[var(--bo-fg)] data-[popup-open]:after:bg-[var(--bo-accent)]",
        )}
      >
        <Icon name="plus" />
      </Popover.Trigger>
      <Popover.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          style={{ zIndex: 2147483647 }}
        >
          <Popover.Popup
            data-backoffice-root
            className={cn(tabMenuPopupClassName, "w-[20rem] origin-top-left")}
          >
            <Popover.Title className={tabMenuTitleClassName}>{title}</Popover.Title>
            <Suspense fallback={<TabPinMenuNote tone="muted">{loading}</TabPinMenuNote>}>
              <TabPinMenuList
                {...list}
                onOpen={() => {
                  setOpen(false);
                }}
              />
            </Suspense>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TabPinMenuList({
  icon,
  items,
  activeId,
  pinnedIds,
  onPinnedChange,
  empty,
  onOpen,
}: TabPinMenuListProps & { onOpen: () => void }) {
  const listed = use(items);
  if (listed.kind === "failed") {
    return <TabPinMenuNote tone="failed">{listed.message}</TabPinMenuNote>;
  }
  if (listed.items.length === 0) {
    return (
      <div className="flex gap-3 px-2.5 pt-1 pb-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]">
          <Icon name={icon} className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-semibold text-[var(--bo-fg)]">{empty.title}</p>
          <p className="text-xs leading-5 text-balance text-[var(--bo-muted)]">
            {empty.description}
          </p>
        </div>
      </div>
    );
  }
  const pinnedIdSet = new Set(pinnedIds);
  return (
    <ul className="flex flex-col gap-0.5">
      {listed.items.map((item) => {
        const active = item.id === activeId;
        const pinned = pinnedIdSet.has(item.id);
        const name = (
          <>
            <Icon
              name={icon}
              className={cn(
                "size-4 shrink-0",
                active ? "text-[var(--bo-accent)]" : "text-[var(--bo-muted-2)]",
              )}
            />
            <span className="min-w-0 truncate">
              {item.detail ? (
                <span className="font-normal text-[var(--bo-muted-2)]">{item.detail}</span>
              ) : null}
              {item.label}
            </span>
          </>
        );
        return (
          <li
            key={item.id}
            className={cn(
              "flex min-h-10 items-center rounded-[4px] pr-1 text-sm text-[var(--bo-fg)] transition-[background-color] duration-150 ease-out",
              active
                ? "bg-[var(--bo-panel-2)] font-semibold"
                : "font-medium hover:bg-[var(--bo-panel-2)]",
            )}
          >
            {active ? (
              <span aria-current="page" className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5">
                {name}
              </span>
            ) : (
              <Link
                to={item.to}
                onClick={onOpen}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[4px] px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
              >
                {name}
              </Link>
            )}
            <button
              type="button"
              aria-label={`Pin ${item.label}`}
              aria-pressed={pinned}
              title={pinned ? "Unpin tab" : "Pin as tab"}
              onClick={() => {
                onPinnedChange(item, !pinned);
              }}
              className={cn(
                "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[4px] outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-[var(--bo-panel)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.9]",
                pinned
                  ? "text-[var(--bo-accent)]"
                  : "text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]",
              )}
            >
              <Icon name="bookmark" className={cn("size-4", pinned && "fill-current")} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TabPinMenuNote({ tone, children }: { tone: "muted" | "failed"; children: string }) {
  return (
    <p
      role={tone === "failed" ? "alert" : "status"}
      className={cn(
        "px-2.5 pb-2 text-xs leading-5 text-pretty",
        tone === "failed" ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted)]",
      )}
    >
      {children}
    </p>
  );
}

/** A path or file name inside menu prose, kept on one line. */
export function TabPinMenuCode({ children }: { children: string }) {
  return (
    <code className="rounded-[3px] bg-[var(--bo-panel-2)] px-1 py-px font-mono text-[11px] whitespace-nowrap text-[var(--bo-fg)]">
      {children}
    </code>
  );
}
