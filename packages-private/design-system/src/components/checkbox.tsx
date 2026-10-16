import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import type { ReactNode } from "react";

import { cn } from "../cn";
import { fieldDensityClassNames, type FieldDensity } from "./field-density";
import { Icon } from "./icon";

// inline sits in running text and option lists; card is a standalone selectable surface.
type CheckboxAppearance = "inline" | "card";

// Labelled checkbox. With a name it submits value (default "on") with its form when checked.
export function Checkbox({
  appearance = "inline",
  checked,
  children,
  className,
  defaultChecked,
  density = "default",
  description,
  disabled = false,
  name,
  required = false,
  value,
  onCheckedChange,
}: {
  appearance?: CheckboxAppearance;
  checked?: boolean;
  children: ReactNode;
  className?: string;
  defaultChecked?: boolean;
  density?: FieldDensity;
  description?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  value?: string;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const text = fieldDensityClassNames(density);
  const card = appearance === "card";

  return (
    <label
      className={cn(
        "flex cursor-pointer items-start has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50",
        card
          ? "gap-3 rounded-[4px] border border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)] transition-[border-color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)]"
          : "gap-2",
        card && (density === "comfortable" ? "min-h-14 px-4 py-3.5" : "min-h-10 px-3 py-2.5"),
        text.label,
        className,
      )}
    >
      <BaseCheckbox.Root
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        name={name}
        required={required}
        value={value}
        onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked)}
        className={cn(
          "group mt-0.5 inline-flex shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-btn-fg)] transition-[border-color,background-color,scale] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-btn-bg)] data-[disabled]:cursor-not-allowed",
          density === "comfortable" ? "size-5" : "size-4",
        )}
      >
        <BaseCheckbox.Indicator>
          <Icon
            name="check"
            className={density === "comfortable" ? "size-3.5" : "size-3"}
            strokeWidth={2}
          />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="min-w-0 flex-1">
        <span className={cn("block", card && "font-semibold text-[var(--bo-fg)]")}>{children}</span>
        {description ? (
          <span className={cn("mt-1 block text-[var(--bo-muted)]", text.description)}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
