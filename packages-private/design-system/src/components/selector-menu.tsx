import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";

// Top-bar dropdown for picking what the chrome is currently about (organization, project,
// account) and jumping to related destinations. The trigger shows a small label over the current
// value; the popup is composed from options, actions, notes, and groups below.

// Non-modal so the page behind stays scrollable and other chrome stays reachable while it is open.
export function SelectorMenu({ children }: { children: ReactNode }) {
  return <Menu.Root modal={false}>{children}</Menu.Root>;
}

// How the trigger occupies its slot in the top bar:
// - "fill" spans its container.
// - "hug" sizes to its content and collapses to the initials below the xl breakpoint.
// - "workspace" fills like "fill" with a coloured workspace tile on the left. When collapsed, only
//   the tile is shown, centered, from the sidebar breakpoint (960px) up, so it lines up with a
//   collapsed sidebar; below that breakpoint there is no sidebar to line up with.
type SelectorMenuTriggerLayout =
  | { kind: "fill" }
  | { kind: "hug"; initials: string }
  | { kind: "workspace"; mark: WorkspaceMark; color: WorkspaceColor; collapsed: boolean };

// What the workspace tile shows: a single letter (e.g. an organization's initial) or an icon.
type WorkspaceMark = { kind: "letter"; letter: string } | { kind: "icon"; icon: IconName };

// The tile is either the app's primary colour or a hue derived from seed. Pass a stable identity
// (not a display name) as the seed to keep the colour across renames.
type WorkspaceColor = { kind: "primary" } | { kind: "seeded"; seed: string };

// FNV-1a keeps the hue stable across sessions and spreads similar seeds apart.
function seedHue(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

// Fixed lightness and chroma keep every hue equally prominent and legible under a white mark.
function workspaceTileColor(seed: string) {
  return `oklch(0.62 0.14 ${seedHue(seed)})`;
}

export function SelectorMenuTrigger({
  label,
  value,
  ariaLabel,
  layout,
}: {
  label: string;
  // null means nothing is selected; the trigger then shows a muted "None".
  value: string | null;
  ariaLabel: string;
  layout: SelectorMenuTriggerLayout;
}) {
  return (
    <Menu.Trigger
      type="button"
      aria-label={ariaLabel}
      className={cn(
        "group flex min-h-12 min-w-0 cursor-pointer items-center gap-2.5 py-3.5 pr-4 pl-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30",
        layout.kind === "hug" ? "shrink-0 self-stretch pr-5.5" : "w-full",
        layout.kind === "workspace" && "pl-5",
        layout.kind === "workspace" &&
          layout.collapsed &&
          "min-[960px]:justify-center min-[960px]:px-0",
      )}
    >
      {layout.kind === "hug" ? (
        <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-xs font-semibold text-[var(--bo-fg)] xl:hidden">
          {layout.initials}
        </span>
      ) : null}
      {layout.kind === "workspace" ? (
        <span
          style={
            layout.color.kind === "seeded"
              ? { backgroundColor: workspaceTileColor(layout.color.seed) }
              : undefined
          }
          className={cn(
            "mr-1 flex size-8 shrink-0 items-center justify-center rounded-[6px]",
            layout.color.kind === "primary"
              ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
              : "text-white",
            layout.collapsed && "min-[960px]:mr-0",
          )}
        >
          {layout.mark.kind === "letter" ? (
            <span className="text-sm leading-none font-semibold">{layout.mark.letter}</span>
          ) : (
            <Icon name={layout.mark.icon} className="size-4" strokeWidth={2} />
          )}
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-col gap-0.5",
          layout.kind === "hug" ? "hidden xl:flex" : "flex flex-1",
          layout.kind === "workspace" && layout.collapsed && "min-[960px]:hidden",
        )}
      >
        <span className="text-[11px] font-semibold text-[var(--bo-muted-2)]">{label}</span>
        <span
          className={cn(
            "min-w-0 truncate text-sm tracking-normal normal-case",
            layout.kind === "hug" && "max-w-36",
            value === null
              ? "font-medium text-[var(--bo-muted-2)]"
              : "font-extrabold text-[var(--bo-fg)]",
          )}
        >
          {value ?? "None"}
        </span>
      </span>
      <Icon
        name="chevron-down"
        className={cn(
          "size-3.5 shrink-0 text-[var(--bo-muted-2)] transition-[transform,color] duration-150 ease-out group-data-[popup-open]:rotate-180 group-data-[popup-open]:text-[var(--bo-accent-fg)]",
          layout.kind === "hug" && "hidden sm:block",
          layout.kind === "workspace" && layout.collapsed && "min-[960px]:hidden",
        )}
      />
    </Menu.Trigger>
  );
}

// Stacked above every other layer, including full-screen overlays opened from the page.
const POPUP_Z_INDEX = 2147483647;

const POPUP_CLASS_NAME =
  "bo-popover-surface overflow-y-auto overscroll-contain rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-1.5 text-left text-[var(--bo-fg)] transition-[opacity,scale] duration-150 ease-out outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0";

// height "capped" keeps long option lists compact and scrollable; "content" shows everything and
// only scrolls when the viewport is too short to fit it.
export function SelectorMenuPopup({
  align,
  height,
  className,
  children,
}: {
  align: "start" | "end";
  height: "capped" | "content";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Menu.Portal style={{ position: "relative", zIndex: POPUP_Z_INDEX }}>
      <Menu.Positioner
        side="bottom"
        align={align}
        sideOffset={4}
        collisionPadding={8}
        style={{ zIndex: POPUP_Z_INDEX }}
      >
        <Menu.Popup
          data-backoffice-root
          className={cn(
            POPUP_CLASS_NAME,
            "w-[min(22rem,calc(100vw-2rem))]",
            height === "capped"
              ? "max-h-[min(32rem,var(--available-height))]"
              : "max-h-[var(--available-height)]",
            align === "start" ? "origin-top-left" : "origin-top-right",
            className,
          )}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

// Captions share the shell's sentence-case sans; the popup's structure comes from spacing and
// separators rather than tracked uppercase labels.
export function SelectorMenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-[var(--bo-muted)]">{children}</p>
  );
}

// Each group is set off from what precedes it by a separator; a group that opens the popup has
// nothing to be set off from, so its separator is hidden.
export function SelectorMenuGroup({
  label,
  children,
}: {
  label: string | null;
  children: ReactNode;
}) {
  return (
    <>
      <Menu.Separator className="mx-1 my-1.5 h-px bg-[var(--bo-border)] first:hidden" />
      <Menu.Group className="flex flex-col gap-0.5">
        {label === null ? null : (
          <Menu.GroupLabel className="truncate px-2.5 pt-1 pb-0.5 text-xs font-medium text-[var(--bo-muted-2)]">
            {label}
          </Menu.GroupLabel>
        )}
        {children}
      </Menu.Group>
    </>
  );
}

const OPTION_CLASS_NAME =
  "flex items-center gap-3 rounded-[4px] px-2.5 py-2 text-left outline-none transition-[background-color,box-shadow] duration-150 ease-out";

// A destination described by a label and, when the label alone is ambiguous, a description. The
// current option is shown selected and cannot be chosen again.
export function SelectorMenuOption({
  to,
  label,
  description,
  badge,
  current,
}: {
  to: string;
  label: string;
  description: string | null;
  badge: string | null;
  current: boolean;
}) {
  const rowClassName = cn(OPTION_CLASS_NAME, description === null ? "min-h-9" : "min-h-12");
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-[var(--bo-fg)]">{label}</span>
        {description === null ? null : (
          <span className="truncate text-xs text-[var(--bo-muted-2)]">{description}</span>
        )}
      </span>
      {badge === null ? null : (
        <span className="shrink-0 rounded-[4px] bg-[var(--bo-panel-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--bo-muted)]">
          {badge}
        </span>
      )}
      {/* Reserved on every option so labels line up whether or not the check is shown. */}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {current ? <Icon name="check" className="size-4 text-[var(--bo-accent)]" /> : null}
      </span>
    </>
  );

  return current ? (
    <Menu.Item
      disabled
      aria-current="true"
      className={cn(
        rowClassName,
        "cursor-default bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)]",
      )}
    >
      {content}
    </Menu.Item>
  ) : (
    <Menu.Item
      render={<Link to={to} preventScrollReset />}
      className={cn(rowClassName, "cursor-pointer data-[highlighted]:bg-[var(--bo-panel-2)]")}
    >
      {content}
    </Menu.Item>
  );
}

const ACTION_CLASS_NAME =
  "group flex min-h-10 cursor-pointer items-center gap-3 rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-fg)] outline-none transition-[background-color,color] duration-150 ease-out data-[highlighted]:bg-[var(--bo-panel-2)] data-[disabled]:cursor-default data-[disabled]:opacity-60";

const ACTION_ICON_CLASS_NAME =
  "size-4 shrink-0 text-[var(--bo-muted)] transition-colors duration-150 ease-out group-data-[highlighted]:text-[var(--bo-fg)]";

export function SelectorMenuLink({
  to,
  icon,
  children,
}: {
  to: string;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <Menu.Item render={<Link to={to} />} className={ACTION_CLASS_NAME}>
      <Icon name={icon} className={ACTION_ICON_CLASS_NAME} strokeWidth={1.75} />
      {children}
    </Menu.Item>
  );
}

// Stays open after a click so pending and error states of the action remain visible.
export function SelectorMenuButton({
  icon,
  disabled,
  onClick,
  children,
}: {
  icon: IconName;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      closeOnClick={false}
      disabled={disabled}
      onClick={onClick}
      className={ACTION_CLASS_NAME}
    >
      <Icon name={icon} className={ACTION_ICON_CLASS_NAME} strokeWidth={1.75} />
      {children}
    </Menu.Item>
  );
}

export function SelectorMenuNote({
  tone,
  children,
}: {
  tone: "muted" | "error";
  children: ReactNode;
}) {
  return tone === "error" ? (
    <p role="alert" className="px-2.5 py-1.5 text-xs text-[var(--bo-failed)]">
      {children}
    </p>
  ) : (
    <p className="px-2.5 py-1.5 text-xs text-[var(--bo-muted-2)]">{children}</p>
  );
}

// A row that opens a nested menu beside the popup, for settings that would otherwise crowd the
// parent list.
export function SelectorSubmenu({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger
        className={cn(ACTION_CLASS_NAME, "data-[popup-open]:bg-[var(--bo-panel-2)]")}
      >
        <Icon name={icon} className={ACTION_ICON_CLASS_NAME} strokeWidth={1.75} />
        <span className="flex-1">{label}</span>
        <Icon name="chevron-right" className="size-3.5 shrink-0 text-[var(--bo-muted-2)]" />
      </Menu.SubmenuTrigger>
      <Menu.Portal style={{ position: "relative", zIndex: POPUP_Z_INDEX }}>
        <Menu.Positioner
          sideOffset={6}
          alignOffset={-6}
          collisionPadding={8}
          style={{ zIndex: POPUP_Z_INDEX }}
        >
          <Menu.Popup
            data-backoffice-root
            className={cn(
              POPUP_CLASS_NAME,
              "max-h-[var(--available-height)] w-[min(14rem,calc(100vw-2rem))] origin-[var(--transform-origin)]",
            )}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
