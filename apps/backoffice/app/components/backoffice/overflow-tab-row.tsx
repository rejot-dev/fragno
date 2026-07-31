import { Menu } from "@base-ui/react/menu";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { visibleOverflowTabCount } from "./overflow-tab-row-layout";

export type OverflowTabRowItem = {
  id: string;
  label: string;
  to: string;
  groupId?: string;
  disabled?: boolean;
  active?: boolean;
  onSelect?: () => void;
};

export type OverflowTabRowVariant = "boxed" | "underline";

const tabClassName = (variant: OverflowTabRowVariant, disabled: boolean, active: boolean) => {
  if (variant === "underline") {
    if (disabled) {
      return "inline-flex min-h-10 shrink-0 cursor-not-allowed items-center border-b-2 border-transparent px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase opacity-50";
    }
    if (active) {
      return "inline-flex min-h-10 shrink-0 items-center border-b-2 border-[color:var(--bo-accent)] px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
    }
    return "inline-flex min-h-10 shrink-0 items-center border-b-2 border-transparent px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase outline-none transition-[scale,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
  }

  if (disabled) {
    return "inline-flex min-h-10 shrink-0 cursor-not-allowed items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase opacity-50";
  }
  if (active) {
    return "inline-flex min-h-10 shrink-0 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
  }
  return "inline-flex min-h-10 shrink-0 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase outline-none transition-[scale,background-color,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
};

const measurementTabClassName = (variant: OverflowTabRowVariant) =>
  variant === "underline"
    ? "inline-flex min-h-10 shrink-0 items-center border-b-2 px-1 text-[10px] font-semibold tracking-[0.22em] uppercase"
    : "inline-flex min-h-10 shrink-0 items-center border px-3 py-2 text-[10px] font-semibold tracking-[0.22em] uppercase";

const moreTriggerClassName = (variant: OverflowTabRowVariant, active: boolean) => {
  if (variant === "underline") {
    return active
      ? "group inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 border-[color:var(--bo-accent)] px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
      : "group inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 border-transparent px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase outline-none transition-[scale,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:border-[color:var(--bo-accent)] data-[popup-open]:text-[var(--bo-accent-fg)]";
  }

  return active
    ? "group inline-flex min-h-10 shrink-0 items-center gap-2 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
    : "group inline-flex min-h-10 shrink-0 items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase outline-none transition-[scale,background-color,border-color,color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:border-[color:var(--bo-accent)] data-[popup-open]:bg-[var(--bo-accent-bg)] data-[popup-open]:text-[var(--bo-accent-fg)]";
};

export function OverflowTabRow({
  items,
  ariaLabel,
  variant = "boxed",
}: {
  items: readonly OverflowTabRowItem[];
  ariaLabel: string;
  variant?: OverflowTabRowVariant;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [visibleTabCount, setVisibleTabCount] = useState(items.length);
  const measurementKey = items
    .map((item) => `${item.id}:${item.label}:${item.groupId ?? ""}`)
    .join("|");

  useLayoutEffect(() => {
    const rail = railRef.current;
    const measurement = measurementRef.current;
    if (!rail || !measurement) {
      return undefined;
    }

    const measureVisibleTabs = () => {
      const measuredElements = Array.from(
        measurement.querySelectorAll<HTMLElement>("[data-overflow-tab-measure]"),
      );
      const moreTrigger = measurement.querySelector<HTMLElement>("[data-more-trigger]");
      const separator = measurement.querySelector<HTMLElement>("[data-group-separator]");
      if (measuredElements.length !== items.length || !moreTrigger || !separator) {
        return;
      }

      const measuredTabs = measuredElements.map((element, index) => ({
        width: element.offsetWidth,
        startsGroup: index > 0 && items[index - 1].groupId !== items[index].groupId,
      }));
      const computedStyle = getComputedStyle(measurement);
      const gapWidth = Number.parseFloat(computedStyle.columnGap) || 8;
      const nextVisibleTabCount = visibleOverflowTabCount({
        availableWidth: rail.clientWidth,
        tabs: measuredTabs,
        moreTriggerWidth: moreTrigger.offsetWidth,
        separatorWidth: separator.offsetWidth,
        gapWidth,
      });
      setVisibleTabCount((current) =>
        current === nextVisibleTabCount ? current : nextVisibleTabCount,
      );
    };

    measureVisibleTabs();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(measureVisibleTabs);
    observer.observe(rail);
    return () => {
      observer.disconnect();
    };
  }, [items, measurementKey, variant]);

  const visibleTabs = items.slice(0, visibleTabCount);
  const overflowTabs = items.slice(visibleTabCount);
  const activeTabIsOverflowing = overflowTabs.some((tab) => tab.active);

  return (
    <div className="relative">
      <div
        ref={measurementRef}
        aria-hidden="true"
        className="invisible absolute flex min-w-max items-center gap-2 whitespace-nowrap"
      >
        {items.map((tab) => (
          <span key={tab.id} data-overflow-tab-measure className={measurementTabClassName(variant)}>
            {tab.label}
          </span>
        ))}
        <span data-group-separator className="h-6 w-px shrink-0" />
        <span data-more-trigger className={`${measurementTabClassName(variant)} gap-2`}>
          More
          <span>99</span>
          <span>▾</span>
        </span>
      </div>

      <nav ref={railRef} aria-label={ariaLabel} className="overflow-hidden">
        <div className="flex min-w-0 items-center gap-2">
          {visibleTabs.map((tab, index) => {
            const startsGroup = index > 0 && visibleTabs[index - 1].groupId !== tab.groupId;
            return (
              <Fragment key={tab.id}>
                {startsGroup ? (
                  <span className="h-6 w-px shrink-0 bg-[var(--bo-border)]" aria-hidden="true" />
                ) : null}
                {tab.disabled ? (
                  <span aria-disabled="true" className={tabClassName(variant, true, false)}>
                    {tab.label}
                  </span>
                ) : (
                  <Link
                    to={tab.to}
                    onClick={tab.onSelect}
                    aria-current={tab.active ? "page" : undefined}
                    className={tabClassName(variant, false, Boolean(tab.active))}
                  >
                    {tab.label}
                  </Link>
                )}
              </Fragment>
            );
          })}

          {overflowTabs.length > 0 ? (
            <Menu.Root modal={false}>
              <Menu.Trigger
                type="button"
                aria-label={`More sections. ${overflowTabs.length} hidden.`}
                className={moreTriggerClassName(variant, activeTabIsOverflowing)}
              >
                More
                <span className="text-[9px] text-[var(--bo-muted-2)]">{overflowTabs.length}</span>
                <span
                  aria-hidden="true"
                  className="text-[8px] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                >
                  ▾
                </span>
              </Menu.Trigger>
              <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
                <Menu.Positioner
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  style={{ zIndex: 2147483647 }}
                >
                  <Menu.Popup
                    data-backoffice-root
                    className="relative max-h-[min(28rem,calc(100vh-6rem))] min-w-56 overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
                  >
                    <p className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      More sections
                    </p>
                    {overflowTabs.map((tab, index) => {
                      const startsGroup =
                        index > 0 && overflowTabs[index - 1].groupId !== tab.groupId;
                      const menuItemClassName = tab.active
                        ? "flex min-h-10 cursor-default items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-sm font-medium text-[var(--bo-accent-fg)] outline-none"
                        : tab.disabled
                          ? "flex min-h-10 cursor-not-allowed items-center border border-transparent px-3 py-2 text-sm text-[var(--bo-muted-2)] opacity-50 outline-none"
                          : "flex min-h-10 items-center border border-transparent px-3 py-2 text-sm text-[var(--bo-muted)] outline-none transition-[background-color,border-color,color] duration-150 ease-out data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";

                      return (
                        <Fragment key={tab.id}>
                          {startsGroup ? (
                            <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
                          ) : null}
                          {tab.disabled || tab.active ? (
                            <Menu.Item disabled className={menuItemClassName}>
                              {tab.label}
                            </Menu.Item>
                          ) : (
                            <Menu.Item
                              render={<Link to={tab.to} onClick={tab.onSelect} />}
                              className={menuItemClassName}
                            >
                              {tab.label}
                            </Menu.Item>
                          )}
                        </Fragment>
                      );
                    })}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
