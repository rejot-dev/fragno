import { Menu } from "@base-ui/react/menu";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { cn } from "../cn";
import { browserTabClassName } from "./browser-tabs";
import { Icon } from "./icon";
import { visibleOverflowTabCount } from "./overflow-tab-row-layout";
import { underlineTabClassName } from "./underline-tab-class-name";

export type OverflowTabRowItem = {
  id: string;
  label: string;
  to: string;
  groupId?: string;
  disabled?: boolean;
  active?: boolean;
  onSelect?: () => void;
};

export type OverflowTabRowVariant = "boxed" | "underline" | "browser";

const tabClassName = (variant: OverflowTabRowVariant, disabled: boolean, active: boolean) => {
  if (variant === "browser") {
    return browserTabClassName(disabled ? "disabled" : active ? "selected" : "idle");
  }

  if (variant === "underline") {
    return underlineTabClassName(disabled ? "disabled" : active ? "selected" : "idle");
  }

  // Boxed tabs are sidebar navigation items laid out in a row: the selected tab is the raised
  // surface, the rest are ghosts until hovered.
  if (disabled) {
    return "inline-flex min-h-10 shrink-0 items-center rounded-[4px] border px-3 text-sm font-semibold cursor-not-allowed border-transparent text-[var(--bo-muted-2)] opacity-50";
  }
  if (active) {
    return "inline-flex min-h-10 shrink-0 items-center rounded-[4px] border px-3 text-sm font-semibold border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)] outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
  }
  return "inline-flex min-h-10 shrink-0 items-center rounded-[4px] border px-3 text-sm font-semibold border-transparent text-[var(--bo-muted)] outline-none transition-[scale,background-color,color] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
};

const measurementTabClassName = (variant: OverflowTabRowVariant) => {
  if (variant === "browser") {
    return browserTabClassName("idle");
  }
  return variant === "underline"
    ? underlineTabClassName("idle")
    : "inline-flex min-h-10 shrink-0 items-center rounded-[4px] border px-3 text-sm font-semibold";
};

const moreTriggerClassName = (variant: OverflowTabRowVariant, active: boolean) => {
  if (variant === "browser") {
    return cn(
      browserTabClassName(active ? "selected" : "idle"),
      "group data-[popup-open]:border-[color:var(--bo-border)] data-[popup-open]:border-b-transparent data-[popup-open]:bg-[var(--bo-panel)] data-[popup-open]:text-[var(--bo-fg)] data-[popup-open]:shadow-[var(--bo-selected-shadow)]",
    );
  }

  if (variant === "underline") {
    return cn(
      underlineTabClassName(active ? "selected" : "idle"),
      "group data-[popup-open]:text-[var(--bo-fg)] data-[popup-open]:after:bg-[var(--bo-accent)]",
    );
  }

  return active
    ? "group inline-flex min-h-10 shrink-0 items-center rounded-[4px] border px-3 text-sm font-semibold gap-2 border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)] outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
    : "group inline-flex min-h-10 shrink-0 items-center rounded-[4px] border px-3 text-sm font-semibold gap-2 border-transparent text-[var(--bo-muted)] outline-none transition-[scale,background-color,color] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:bg-[var(--bo-panel-2)] data-[popup-open]:text-[var(--bo-fg)]";
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
  const rowGapClassName = variant === "boxed" ? "gap-2" : "gap-4";

  return (
    <div className="relative">
      <div
        ref={measurementRef}
        aria-hidden="true"
        className={`invisible absolute flex min-w-max items-center ${rowGapClassName} whitespace-nowrap`}
      >
        {items.map((tab) => (
          <span key={tab.id} data-overflow-tab-measure className={measurementTabClassName(variant)}>
            {tab.label}
          </span>
        ))}
        <span data-group-separator className="h-6 w-px shrink-0" />
        <span data-more-trigger className={`${measurementTabClassName(variant)} gap-2`}>
          More
          <span className="text-xs tabular-nums">99</span>
          <span className="size-3.5 shrink-0" />
        </span>
      </div>

      <nav ref={railRef} aria-label={ariaLabel} className="overflow-hidden">
        <div className={`flex min-w-0 items-center ${rowGapClassName}`}>
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
                <span className="text-xs text-[var(--bo-muted-2)] tabular-nums">
                  {overflowTabs.length}
                </span>
                <Icon
                  name="chevron-down"
                  className="size-3.5 shrink-0 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                />
              </Menu.Trigger>
              <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
                <Menu.Positioner
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  style={{ zIndex: 2147483647 }}
                >
                  <Menu.Popup
                    data-backoffice-root
                    className="bo-popover-surface relative flex max-h-[min(28rem,calc(100vh-6rem))] min-w-56 origin-top-right flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-1.5 text-left text-[var(--bo-fg)] transition-[opacity,scale] duration-150 ease-out outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
                  >
                    <p className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-[var(--bo-muted)]">
                      More sections
                    </p>
                    {overflowTabs.map((tab, index) => {
                      const startsGroup =
                        index > 0 && overflowTabs[index - 1].groupId !== tab.groupId;
                      const menuItemClassName = tab.active
                        ? "flex min-h-10 cursor-default items-center rounded-[4px] bg-[var(--bo-selected-bg)] px-2.5 text-sm font-semibold text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)] outline-none"
                        : tab.disabled
                          ? "flex min-h-10 cursor-not-allowed items-center rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-muted-2)] opacity-50 outline-none"
                          : "flex min-h-10 cursor-pointer items-center rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-fg)] outline-none transition-[background-color] duration-150 ease-out data-[highlighted]:bg-[var(--bo-panel-2)]";

                      return (
                        <Fragment key={tab.id}>
                          {startsGroup ? (
                            <Menu.Separator className="mx-1 my-1.5 h-px bg-[var(--bo-border)]" />
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
