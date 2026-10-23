// Menus that open from a tab row list tabs, so the More overflow and the add menu share one look.
type TabMenuItemState = "selected" | "idle" | "disabled";

export const tabMenuPopupClassName =
  "bo-popover-surface relative flex max-h-[min(28rem,calc(100vh-6rem))] min-w-56 origin-top-right flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-1.5 text-left text-[var(--bo-fg)] transition-[opacity,scale] duration-150 ease-out outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0";

export const tabMenuTitleClassName =
  "px-2.5 pt-1.5 pb-1 text-xs font-semibold text-[var(--bo-muted)]";

const ITEM_STATES: Record<TabMenuItemState, string> = {
  // The raised selected surface of tabs disappears on a popup, which is already that surface.
  selected:
    "flex min-h-10 cursor-default items-center rounded-[4px] bg-[var(--bo-panel-2)] px-2.5 text-sm font-semibold text-[var(--bo-fg)] outline-none",
  disabled:
    "flex min-h-10 cursor-not-allowed items-center rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-muted-2)] opacity-50 outline-none",
  idle: "flex min-h-10 cursor-pointer items-center rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-fg)] outline-none transition-[background-color] duration-150 ease-out data-[highlighted]:bg-[var(--bo-panel-2)]",
};

export function tabMenuItemClassName(state: TabMenuItemState) {
  return ITEM_STATES[state];
}
