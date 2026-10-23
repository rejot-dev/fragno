import { Menu } from "@base-ui/react/menu";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../cn";
import { Icon } from "./icon";
import { WorkingIndicator } from "./working-indicator";

// The composer's form and buttons spread their props so a chat runtime can render them as its own
// primitives (for example through `asChild`), which supply submission and disabled state.

/** The composer's frame: waiting messages, the input, then a toolbar. */
export function ChatComposer({
  disabled,
  ...props
}: Omit<ComponentProps<"form">, "className"> & { disabled: boolean }) {
  return (
    <form
      aria-disabled={disabled}
      {...props}
      // Shares the selected navigation item's surface, like the other prompt fields.
      className={cn("bo-input p-2", disabled && "cursor-not-allowed opacity-50")}
    />
  );
}

/**
 * For the composer's textarea. A class name rather than a component, because chat runtimes
 * render their own auto-growing textarea.
 */
export const chatComposerInputClassName =
  "max-h-48 min-h-14 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] disabled:cursor-not-allowed";

/** A message waiting to reach the agent, labelled with how it will arrive. */
export function ChatComposerQueueItem({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-1 mb-1 flex items-baseline gap-2 border-l-2 border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-xs">
      <span className="shrink-0 text-[9px] font-semibold tracking-[0.12em] text-[var(--bo-accent-fg)] uppercase">
        {label}
      </span>
      <span className="line-clamp-2 min-w-0 text-pretty whitespace-pre-wrap text-[var(--bo-fg)]">
        {children}
      </span>
    </div>
  );
}

/** Context about the conversation on the left; what the reader can do on the right. */
export function ChatComposerToolbar({ start, end }: { start: ReactNode; end: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-2 px-1">
      <div className="flex min-w-0 items-center gap-2">{start}</div>
      <div className="flex items-center gap-1">{end}</div>
    </div>
  );
}

/** The model answering, hidden on narrow screens. */
export function ChatComposerModel({ children }: { children: string }) {
  return (
    <span className="hidden max-w-44 truncate px-2 text-[10px] text-[var(--bo-muted-2)] sm:block">
      {children}
    </span>
  );
}

export type ChatComposerModelOption<TValue extends string> = { value: TValue; label: string };

const MODEL_MENU_ITEM_CLASS_NAME =
  "flex min-h-9 cursor-default items-center gap-2 px-2.5 text-left text-xs text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out outline-none active:scale-[0.98] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)] data-[checked]:text-[var(--bo-fg)]";

function ChatComposerModelMenuGroup<TValue extends string>({
  heading,
  value,
  options,
  onValueChange,
}: {
  heading: string;
  value: TValue;
  options: readonly ChatComposerModelOption<TValue>[];
  onValueChange: (value: TValue) => void;
}) {
  return (
    <Menu.Group>
      <Menu.GroupLabel className="px-2.5 py-1 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
        {heading}
      </Menu.GroupLabel>
      <Menu.RadioGroup
        value={value}
        onValueChange={(nextValue: unknown) => {
          const option = options.find((candidate) => candidate.value === nextValue);
          if (option) {
            onValueChange(option.value);
          }
        }}
        className="space-y-0.5"
      >
        {options.map((option) => (
          <Menu.RadioItem
            key={option.value}
            value={option.value}
            className={MODEL_MENU_ITEM_CLASS_NAME}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
                <Icon name="check" className="size-4" />
              </Menu.RadioItemIndicator>
            </span>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Group>
  );
}

/**
 * Chooses the model answering and how hard it reasons, in place of the model label. Offer only the
 * efforts the chosen model supports. Choosing keeps the menu open, so both can be chosen at once.
 */
export function ChatComposerModelMenu<TModel extends string, TEffort extends string>({
  disabled,
  model,
  models,
  onModelChange,
  effort,
  efforts,
  onEffortChange,
}: {
  disabled: boolean;
  model: TModel;
  models: readonly ChatComposerModelOption<TModel>[];
  onModelChange: (model: TModel) => void;
  effort: TEffort;
  efforts: readonly ChatComposerModelOption<TEffort>[];
  onEffortChange: (effort: TEffort) => void;
}) {
  const modelLabel = models.find((option) => option.value === model)?.label ?? model;
  const effortLabel = efforts.find((option) => option.value === effort)?.label ?? effort;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        disabled={disabled}
        aria-label={`Model: ${modelLabel}, reasoning effort: ${effortLabel}`}
        title="Choose model and reasoning effort"
        className="group inline-flex min-h-8 max-w-52 min-w-0 items-center gap-1 px-2 text-[10px] text-[var(--bo-muted-2)] transition-[color,scale] duration-150 ease-out outline-none hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:not-disabled:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-35 data-[popup-open]:text-[var(--bo-fg)]"
      >
        <span className="min-w-0 truncate">{modelLabel}</span>
        <span aria-hidden className="shrink-0 text-[var(--bo-muted-2)]">
          ·
        </span>
        <span className="shrink-0">{effortLabel}</span>
        <Icon
          name="chevron-down"
          className="size-3 shrink-0 transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Menu.Popup
            data-backoffice-root
            className="bo-popover-surface w-56 origin-bottom-left space-y-2 bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] outline-none"
          >
            <ChatComposerModelMenuGroup
              heading="Model"
              value={model}
              options={models}
              onValueChange={onModelChange}
            />
            <Menu.Separator className="mx-1 h-px bg-[var(--bo-border)]" />
            <ChatComposerModelMenuGroup
              heading="Reasoning effort"
              value={effort}
              options={efforts}
              onValueChange={onEffortChange}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Why the composer is unavailable, or what the agent is busy with; hidden on narrow screens. */
export function ChatComposerStatus({ working, children }: { working: boolean; children: string }) {
  return working ? (
    <span className="hidden sm:inline-flex">
      <WorkingIndicator>{children}</WorkingIndicator>
    </span>
  ) : (
    <span className="hidden text-xs text-[var(--bo-muted-2)] sm:inline">{children}</span>
  );
}

/** Holds a button and the menu that switches what it does, as one split button. */
export function ChatComposerSplit({ children }: { children: ReactNode }) {
  // The split carries the shadow so it falls once behind both halves, not into the seam.
  return (
    <div className="flex items-stretch rounded-[4px] shadow-[var(--bo-selected-shadow)]">
      {children}
    </div>
  );
}

/**
 * Turns speech into composer text. The microphone stays until the speech service is listening,
 * then turns into a stop control.
 */
export function ChatComposerDictationButton({
  state,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "className" | "children"> & {
  state: "idle" | "starting" | "listening";
}) {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "inline-flex min-h-10 w-10 items-center justify-center rounded-[4px] shadow-[var(--bo-selected-shadow)] transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:not-disabled:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-35",
        state === "idle"
          ? "bg-[var(--bo-selected-bg)] text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]"
          : "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]",
      )}
    >
      {state === "listening" ? (
        <span className="size-2.5 animate-pulse bg-[var(--bo-accent)]" />
      ) : (
        <Icon name="mic" className="size-4" />
      )}
    </button>
  );
}

/**
 * Accent sends to the agent and never looks disabled, so the primary action stays legible while
 * there is nothing to send yet; neutral interrupts it. A joined button is the first half of a
 * ChatComposerSplit, which carries the shadow and rounds only its outer corners.
 */
export function ChatComposerButton({
  tone,
  joined,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "className"> & {
  tone: "accent" | "neutral";
  joined: boolean;
}) {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "inline-flex min-h-10 items-center text-sm font-semibold transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:not-disabled:scale-[0.96]",
        tone === "accent"
          ? "bg-[var(--bo-fg)] px-4 text-[var(--bo-panel)] hover:not-disabled:bg-[color-mix(in_srgb,var(--bo-fg)_82%,var(--bo-panel))]"
          : "bg-[var(--bo-selected-bg)] px-3 text-[var(--bo-fg)] hover:text-[var(--bo-failed)] disabled:cursor-not-allowed",
        joined ? "rounded-l-[4px]" : "rounded-[4px] shadow-[var(--bo-selected-shadow)]",
      )}
    />
  );
}
