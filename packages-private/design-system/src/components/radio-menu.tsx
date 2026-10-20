import { Menu } from "@base-ui/react/menu";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";

export type RadioMenuOption<TValue extends string> = {
  value: TValue;
  label: string;
  description: string | null;
  icon: IconName | null;
  disabled: boolean;
};

// accent sits flush against an accent button, as the second half of a split button; control is a
// standalone toolbar control showing the given icon.
type RadioMenuTrigger = { kind: "accent" } | { kind: "control"; icon: IconName };

const TRIGGER_CLASS_NAMES: Record<RadioMenuTrigger["kind"], string> = {
  accent:
    "min-h-10 w-9 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] hover:bg-[var(--bo-panel)] focus-visible:ring-[color:var(--bo-accent)]/25 disabled:cursor-not-allowed disabled:opacity-35 data-[popup-open]:bg-[var(--bo-panel)]",
  control:
    "bo-control-surface size-10 bg-[var(--bo-panel)] text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-[color:var(--bo-accent)]/30 data-[popup-open]:bg-[var(--bo-accent-bg)] data-[popup-open]:text-[var(--bo-accent-fg)]",
};

/** A menu that picks one of a few modes, such as what a composer does or how a panel displays. */
export function RadioMenu<TValue extends string>({
  label,
  heading,
  trigger,
  side,
  disabled = false,
  value,
  options,
  onValueChange,
}: {
  /** Names the trigger for screen readers and its tooltip. */
  label: string;
  heading: string | null;
  trigger: RadioMenuTrigger;
  side: "top" | "bottom";
  disabled?: boolean;
  value: TValue;
  options: readonly RadioMenuOption<TValue>[];
  onValueChange: (value: TValue) => void;
}) {
  const described = options.some((option) => option.description !== null);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center transition-[background-color,color,scale,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 active:not-disabled:scale-[0.96]",
          TRIGGER_CLASS_NAMES[trigger.kind],
        )}
      >
        <Icon
          name={trigger.kind === "accent" ? "chevron-down" : trigger.icon}
          className={trigger.kind === "accent" ? "size-3.5" : "size-4"}
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={side} align="end" sideOffset={8} className="z-50">
          <Menu.Popup
            data-backoffice-root
            className={cn(
              "bo-popover-surface bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] outline-none",
              described ? "w-72" : "w-44",
              side === "top" ? "origin-bottom-right" : "origin-top-right",
            )}
          >
            {heading === null ? null : (
              <p className="px-2.5 py-1 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                {heading}
              </p>
            )}
            <Menu.RadioGroup
              value={value}
              onValueChange={(nextValue: unknown) => {
                const option = options.find((candidate) => candidate.value === nextValue);
                if (option) {
                  onValueChange(option.value);
                }
              }}
              className="space-y-1"
            >
              {options.map((option) => (
                <Menu.RadioItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    "flex cursor-default items-center gap-2 px-2.5 text-left text-xs text-[var(--bo-muted)] transition-[background-color,color,opacity,scale] duration-150 ease-out outline-none active:scale-[0.98] data-[disabled]:opacity-35 data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]",
                    option.description === null ? "min-h-10" : "min-h-14",
                  )}
                >
                  {option.icon === null ? null : <Icon name={option.icon} className="size-4" />}
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block",
                        option.description === null ? null : "font-medium text-[var(--bo-fg)]",
                      )}
                    >
                      {option.label}
                    </span>
                    {option.description === null ? null : (
                      <span className="mt-0.5 block text-[10px] leading-4 text-[var(--bo-muted-2)]">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
                      <Icon name="check" className="size-4" />
                    </Menu.RadioItemIndicator>
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
