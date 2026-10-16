import { Checkbox } from "@base-ui/react/checkbox";
import { Field as BaseField } from "@base-ui/react/field";
import type { ReactNode } from "react";

import { cn } from "../cn";
import { Icon } from "./icon";

// compact fits controls embedded in dense panels such as generated workflow UIs, default is the
// in-app form size, and comfortable suits standalone pages such as public form responses.
export type FieldDensity = "compact" | "default" | "comfortable";

const DENSITY: Record<
  FieldDensity,
  { stack: string; label: string; description: string; control: string }
> = {
  compact: {
    stack: "space-y-1.5",
    label: "text-xs",
    description: "text-[11px] leading-4",
    control: "min-h-10 px-3 text-xs",
  },
  default: {
    stack: "space-y-2",
    label: "text-sm",
    description: "text-xs leading-5",
    control: "min-h-11 px-3 text-sm",
  },
  comfortable: {
    stack: "space-y-2.5",
    label: "text-sm",
    description: "text-xs leading-5",
    control: "min-h-12 px-4 text-[15px]",
  },
};

/** Height, padding, and type size of a control on the shared .bo-input surface. */
export function fieldControlClassName(density: FieldDensity) {
  return DENSITY[density].control;
}

function FieldRequiredMark({ density }: { density: FieldDensity }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[4px] bg-[var(--bo-panel-2)] px-1.5 py-0.5 font-medium text-[var(--bo-muted)]",
        density === "compact" ? "text-[10px]" : "text-[11px]",
      )}
    >
      Required
    </span>
  );
}

function FieldError({ density, error }: { density: FieldDensity; error: string | null }) {
  return (
    <BaseField.Error
      match={error !== null}
      className={cn("text-[var(--bo-failed)]", DENSITY[density].description)}
    >
      {error}
    </BaseField.Error>
  );
}

// Labelled form field. The control is passed as children and must carry controlId as its id so the
// label targets it. Base UI controls are described automatically; a native control references the
// description as `${controlId}-description`. A null error renders the field as valid.
export function Field({
  children,
  controlId,
  density,
  description,
  error,
  label,
  required,
}: {
  children: ReactNode;
  controlId: string;
  density: FieldDensity;
  description: string | undefined;
  error: string | null;
  label: string;
  required: boolean;
}) {
  return (
    <BaseField.Root invalid={error !== null} className={cn("min-w-0", DENSITY[density].stack)}>
      <BaseField.Label
        htmlFor={controlId}
        className={cn(
          "flex items-center justify-between gap-3 font-semibold text-[var(--bo-fg)]",
          DENSITY[density].label,
        )}
      >
        <span>{label}</span>
        {required ? <FieldRequiredMark density={density} /> : null}
      </BaseField.Label>
      {description ? (
        <BaseField.Description
          id={`${controlId}-description`}
          className={cn("block text-[var(--bo-muted)]", DENSITY[density].description)}
        >
          {description}
        </BaseField.Description>
      ) : null}
      {children}
      <FieldError density={density} error={error} />
    </BaseField.Root>
  );
}

// Boolean field: the label and description sit inside a selectable card next to the box.
export function CheckboxField({
  checked,
  controlId,
  density,
  description,
  disabled,
  error,
  label,
  required,
  onCheckedChange,
}: {
  checked: boolean;
  controlId: string;
  density: FieldDensity;
  description: string | undefined;
  disabled: boolean;
  error: string | null;
  label: string;
  required: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <BaseField.Root invalid={error !== null} className={cn("min-w-0", DENSITY[density].stack)}>
      <label
        htmlFor={controlId}
        className={cn(
          "flex cursor-pointer items-start gap-3 rounded-[4px] border border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)] transition-[border-color] duration-150 ease-out hover:border-[color:var(--bo-border-strong)] has-disabled:cursor-not-allowed has-disabled:opacity-50",
          density === "comfortable" ? "min-h-14 px-4 py-3.5" : "min-h-10 px-3 py-2.5",
        )}
      >
        <Checkbox.Root
          id={controlId}
          checked={checked}
          disabled={disabled}
          required={required}
          onCheckedChange={onCheckedChange}
          className={cn(
            "group mt-0.5 inline-flex shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-btn-fg)] transition-[border-color,background-color,scale] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-btn-bg)] data-[disabled]:cursor-not-allowed",
            density === "compact" ? "size-4" : "size-5",
          )}
        >
          <Checkbox.Indicator>
            <Icon
              name="check"
              className={density === "compact" ? "size-3" : "size-3.5"}
              strokeWidth={2}
            />
          </Checkbox.Indicator>
        </Checkbox.Root>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "flex items-center justify-between gap-3 font-semibold text-[var(--bo-fg)]",
              DENSITY[density].label,
            )}
          >
            {label}
            {required ? <FieldRequiredMark density={density} /> : null}
          </span>
          {description ? (
            <span className={cn("mt-1 block text-[var(--bo-muted)]", DENSITY[density].description)}>
              {description}
            </span>
          ) : null}
        </span>
      </label>
      <FieldError density={density} error={error} />
    </BaseField.Root>
  );
}
