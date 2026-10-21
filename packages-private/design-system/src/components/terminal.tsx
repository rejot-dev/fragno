import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, type ComponentProps, type ReactNode, type Ref } from "react";

import { cn } from "../cn";
import { IconButton } from "./button";
import { Icon } from "./icon";
import { SelectorMenuChoice, SelectorMenuGroup, SelectorMenuPopup } from "./selector-menu";

// The terminal's parts spread their element props so the app can wire them to its own command
// state, form submission, and ARIA relationships; these components only own the presentation.

/**
 * A terminal that drops down from the top of the viewport over a blurred backdrop: full width on
 * small screens, a centered console on large ones. Stays mounted while closed so its slide-out
 * animation can play and the session keeps its scroll position.
 */
export function TerminalOverlay({
  open,
  label,
  scope,
  hint,
  shortcut,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  scope: ReactNode;
  hint: string;
  shortcut: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    // Locking the page's scroll hides its scrollbar; keep the scrollbar's gutter so the page
    // behind does not widen and shift. Pages without a classic scrollbar get no gutter.
    const root = document.documentElement;
    const hasScrollbar = window.innerWidth > root.clientWidth;
    const previous = { overflow: root.style.overflow, gutter: root.style.scrollbarGutter };
    root.style.overflow = "hidden";
    if (hasScrollbar) {
      root.style.scrollbarGutter = "stable";
    }
    return () => {
      root.style.overflow = previous.overflow;
      root.style.scrollbarGutter = previous.gutter;
    };
  }, [open]);

  return (
    // Apps portal the overlay out of their shell, so it carries the palette root itself.
    <div
      data-backoffice-root
      aria-hidden={!open}
      className={cn(
        "fixed inset-0 z-[80] transition-[visibility] duration-200 motion-reduce:transition-none",
        open ? "visible" : "invisible delay-200",
      )}
    >
      <button
        type="button"
        aria-label="Close terminal"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={cn(
          "absolute inset-0 cursor-default bg-[color:color-mix(in_srgb,var(--bo-bg)_24%,transparent)] backdrop-blur-sm transition-opacity duration-200 ease-out motion-reduce:transition-none",
          open ? "opacity-100" : "opacity-0",
        )}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn(
          "absolute top-0 right-0 left-0 flex h-[min(32rem,calc(100dvh-5rem))] min-h-0 flex-col overflow-visible border-b border-[color:var(--bo-border-strong)] bg-[color:color-mix(in_srgb,var(--bo-panel)_74%,transparent)] shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur-3xl transition-transform duration-200 ease-out motion-reduce:transition-none lg:mx-auto lg:w-[min(calc(100%-4rem),72rem)] lg:border-x",
          open ? "translate-y-0" : "-translate-y-[calc(100%+2rem)]",
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-[color:var(--bo-border)] bg-[color:color-mix(in_srgb,var(--bo-panel)_62%,transparent)] px-4 backdrop-blur-3xl sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <p className="text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-fg)] uppercase">
              Terminal
            </p>
            {scope}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <p className="hidden text-[10px] tracking-[0.08em] text-[var(--bo-muted-2)] md:block">
              {hint}
            </p>
            <kbd className="border border-[color:var(--bo-border)] bg-[color:color-mix(in_srgb,var(--bo-panel-2)_50%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--bo-muted)]">
              {shortcut}
            </kbd>
            <IconButton label="Close terminal" onClick={onClose} className="text-lg">
              ×
            </IconButton>
          </div>
        </header>

        {children}
      </section>
    </div>
  );
}

/** A scope commands can run in, named by what `use` accepts. */
export type TerminalScopeChoice = {
  id: string;
  name: string;
  label: string;
  current: boolean;
};

/**
 * Switches the scope commands run in. Controlled, so the terminal can open it from the keyboard
 * and leave Escape to it while it is open.
 */
export function TerminalScopeMenu({
  open,
  onOpenChange,
  label,
  groups,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  groups: readonly { label: string; choices: readonly TerminalScopeChoice[] }[];
  onChoose: (id: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Opened from the keyboard (⌃O in the prompt), focus would stay behind in the prompt, leaving the
  // arrows and Escape to it; hand focus to the first choice instead.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const popupId = triggerRef.current?.getAttribute("aria-controls");
      const popup = popupId ? document.getElementById(popupId) : null;
      if (popup && !popup.contains(document.activeElement)) {
        popup.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  return (
    <Menu.Root
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
      }}
    >
      <Menu.Trigger
        ref={triggerRef}
        type="button"
        aria-label={`Switch terminal scope. Current scope: ${label}`}
        title="Switch scope (⌃O)"
        className="group flex h-7 min-w-0 cursor-pointer items-center gap-1.5 border border-[color:var(--bo-border)] bg-[color:color-mix(in_srgb,var(--bo-panel-2)_50%,transparent)] px-2 text-xs font-semibold text-[var(--bo-fg)] outline-none hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 data-[popup-open]:border-[color:var(--bo-border-strong)]"
      >
        <span className="size-1.5 shrink-0 bg-[var(--bo-accent)]" />
        <span className="min-w-0 truncate">{label}</span>
        <Icon
          name="chevron-down"
          className="size-3 shrink-0 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
        />
      </Menu.Trigger>
      <SelectorMenuPopup align="start" height="capped">
        {groups.map((group) =>
          group.choices.length === 0 ? null : (
            <SelectorMenuGroup key={group.label} label={group.label}>
              {group.choices.map((choice) => (
                <SelectorMenuChoice
                  key={choice.id}
                  label={choice.label}
                  description={null}
                  badge={`use ${choice.name}`}
                  current={choice.current}
                  onSelect={() => {
                    onChoose(choice.id);
                  }}
                />
              ))}
            </SelectorMenuGroup>
          ),
        )}
      </SelectorMenuPopup>
    </Menu.Root>
  );
}

// Long lines wrap at the panel edge wherever they reach it, like a terminal, rather than
// scrolling sideways or waiting for a space.
const TERMINAL_WRAP_CLASS_NAME = "whitespace-pre-wrap [overflow-wrap:anywhere]";

/** The scrollback; the app owns the ref to keep it pinned to the newest entry. */
export function TerminalLog({ ref, children }: { ref: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div
      ref={ref}
      className="backoffice-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-[color:color-mix(in_srgb,var(--bo-bg)_38%,transparent)] px-5 py-3 font-mono text-xs leading-6 text-[var(--bo-fg)]"
    >
      {children}
    </div>
  );
}

/** What the terminal says before anyone has typed, such as where it is connected. */
export function TerminalBanner({ children }: { children: string }) {
  return (
    <pre className={cn("mb-3 text-[var(--bo-muted)]", TERMINAL_WRAP_CLASS_NAME)}>{children}</pre>
  );
}

/** One command and its output, with how it ended and when, aligned right of the command. */
export function TerminalLogEntry({
  timestamp,
  cwd,
  command,
  output,
  ok,
  exitCode,
  durationMs,
}: {
  timestamp: string;
  cwd: string;
  command: string;
  output: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <TerminalCommandEcho
        cwd={cwd}
        command={command}
        status={
          <>
            {ok ? null : <span className="text-red-400">exit {exitCode} · </span>}
            {durationMs}ms · {new Date(timestamp).toLocaleTimeString()}
          </>
        }
      />
      {output ? (
        <pre className={cn(TERMINAL_WRAP_CLASS_NAME, ok ? "text-[var(--bo-fg)]" : "text-red-400")}>
          {output}
        </pre>
      ) : null}
    </div>
  );
}

/** A submitted command that has not finished yet. */
export function TerminalLogPending({ cwd, command }: { cwd: string; command: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <TerminalCommandEcho
        cwd={cwd}
        command={command}
        status={<span className="animate-pulse text-[var(--bo-accent-fg)]">running…</span>}
      />
    </div>
  );
}

/** The command as typed, with bash's `>` continuation prompt on every line after the first. */
function TerminalCommandEcho({
  cwd,
  command,
  status,
}: {
  cwd: string;
  command: string;
  status: ReactNode;
}) {
  const [firstLine = "", ...continuationLines] = command.split("\n");
  return (
    <div className="flex items-start gap-4">
      <div className={cn("min-w-0 flex-1", TERMINAL_WRAP_CLASS_NAME)}>
        <p>
          <span className="text-[var(--bo-accent-fg)]">{cwd}</span>
          <span className="text-[var(--bo-muted)]"> $ </span>
          {firstLine}
        </p>
        {continuationLines.map((line, index) => (
          <p key={index}>
            <span className="text-[var(--bo-muted)]">&gt; </span>
            {line}
          </p>
        ))}
      </div>
      <p className="shrink-0 text-[10px] text-[var(--bo-muted-2)] tabular-nums">{status}</p>
    </div>
  );
}

/**
 * The command line: the scope and working directory it runs in, then a textarea that grows a line
 * at a time, marking each continuation line with `>` as bash does.
 */
export function TerminalPrompt({
  scope,
  cwd,
  value,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "value" | "rows" | "children"> & {
  scope: string;
  cwd: string;
  value: string;
}) {
  const lines = value.split("\n");
  return (
    // The invisible copy of each line sits in the textarea's column with the same font and
    // wrapping, so its rows size the textarea and line the `>` markers up with wrapped lines.
    <div className="grid max-h-52 grid-cols-[fit-content(42%)_minmax(0,1fr)] overflow-y-auto bg-[color:color-mix(in_srgb,var(--bo-panel-2)_46%,transparent)] py-2 font-mono text-sm leading-6 backdrop-blur-2xl focus-within:bg-[color:color-mix(in_srgb,var(--bo-panel-2)_68%,transparent)]">
      <div
        title={`${scope}:${cwd}`}
        className="col-start-1 row-start-1 truncate pr-2 pl-5 whitespace-nowrap"
      >
        <span className="text-[var(--bo-muted)]">{scope}:</span>
        <span className="text-[var(--bo-accent-fg)]">{shortenCwd(cwd)}</span>
        <span className="text-[var(--bo-muted)]"> $</span>
      </div>
      {lines.slice(1).map((_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="col-start-1 pr-2 pl-5 text-right text-[var(--bo-muted)]"
          style={{ gridRow: index + 2 }}
        >
          &gt;
        </span>
      ))}
      {lines.map((line, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn("invisible col-start-2 pr-5", TERMINAL_WRAP_CLASS_NAME)}
          style={{ gridRow: index + 1 }}
        >
          {line || " "}
        </span>
      ))}
      <textarea
        {...props}
        value={value}
        rows={1}
        className={cn(
          "col-start-2 h-full resize-none overflow-hidden bg-transparent p-0 pr-5 text-[var(--bo-fg)] outline-none placeholder:text-[color:color-mix(in_srgb,var(--bo-muted-2)_45%,transparent)] disabled:opacity-60",
          TERMINAL_WRAP_CLASS_NAME,
        )}
        style={{ gridRow: `1 / span ${lines.length}` }}
      />
    </div>
  );
}

/** Keeps the deepest directories of a long path, which say where you are. */
function shortenCwd(cwd: string) {
  const maxLength = 44;
  if (cwd.length <= maxLength) {
    return cwd;
  }

  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return `…${cwd.slice(-(maxLength - 1))}`;
  }

  for (
    let visiblePartCount = Math.min(parts.length, 4);
    visiblePartCount >= 1;
    visiblePartCount -= 1
  ) {
    const shortened = `/…/${parts.slice(-visiblePartCount).join("/")}`;
    if (shortened.length <= maxLength || visiblePartCount === 1) {
      return shortened;
    }
  }

  return cwd;
}

/**
 * Completions or history matches, hanging below the overlay. Rendered as a direct child of
 * `TerminalOverlay`, whose height its own height limit is derived from.
 */
export function TerminalSuggestions({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="absolute top-full left-0 z-20 mt-2 w-full overflow-hidden border border-[color:var(--bo-border-strong)] bg-[color:color-mix(in_srgb,var(--bo-panel)_88%,transparent)] shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-3xl">
      {/* The overlay is min(32rem, 100dvh - 5rem) tall; the list fits the viewport below it. */}
      <div
        id={id}
        role="listbox"
        aria-label={label}
        className="max-h-[min(18rem,40dvh,calc(100dvh_-_min(32rem,100dvh_-_5rem)_-_0.5rem))] overflow-auto py-1"
      >
        {children}
      </div>
    </div>
  );
}

/** Pressing selects without taking focus from the command line. */
export function TerminalSuggestion({
  kind,
  label,
  description,
  active,
  ...props
}: Omit<ComponentProps<"button">, "className" | "children" | "type" | "role"> & {
  kind: string;
  label: string;
  description: string;
  active: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      className={cn(
        "flex min-h-16 w-full items-start gap-3 px-3 py-2 text-left font-mono text-xs transition-colors",
        active
          ? "bg-[var(--bo-selected-bg)] font-semibold text-[var(--bo-fg)] shadow-[inset_3px_0_0_var(--bo-accent)]"
          : "text-[var(--bo-fg)] hover:bg-[var(--bo-panel-2)]",
      )}
    >
      <span className="mt-0.5 min-w-16 text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
        {kind}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        <span className="mt-1 block truncate font-sans text-[11px] text-[var(--bo-muted)]">
          {description}
        </span>
      </span>
    </button>
  );
}
