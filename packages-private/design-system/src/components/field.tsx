import { Field as BaseField } from "@base-ui/react/field";
import type { ReactNode } from "react";

import { cn } from "../cn";
import { Checkbox } from "./checkbox";
import { fieldDensityClassNames, type FieldDensity } from "./field-density";

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
      className={cn("text-[var(--bo-failed)]", fieldDensityClassNames(density).description)}
    >
      {error}
    </BaseField.Error>
  );
}

// Labelled form field around one control. Design-system controls register with the field, so the
// label targets them and the description and error describe them. A null error is valid.
export function Field({
  children,
  className,
  density = "default",
  description,
  error = null,
  label,
  required = false,
}: {
  children: ReactNode;
  className?: string;
  density?: FieldDensity;
  description?: string;
  error?: string | null;
  label: string;
  required?: boolean;
}) {
  return (
    <BaseField.Root
      invalid={error !== null}
      className={cn("min-w-0", fieldDensityClassNames(density).stack, className)}
    >
      <BaseField.Label
        className={cn(
          "flex items-center justify-between gap-3 font-semibold text-[var(--bo-fg)]",
          fieldDensityClassNames(density).label,
        )}
      >
        <span>{label}</span>
        {required ? <FieldRequiredMark density={density} /> : null}
      </BaseField.Label>
      {description ? (
        <BaseField.Description
          className={cn(
            "block text-[var(--bo-muted)]",
            fieldDensityClassNames(density).description,
          )}
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
  density = "default",
  description,
  disabled = false,
  error = null,
  label,
  required = false,
  onCheckedChange,
}: {
  checked: boolean;
  density?: FieldDensity;
  description?: string;
  disabled?: boolean;
  error?: string | null;
  label: string;
  required?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <BaseField.Root
      invalid={error !== null}
      className={cn("min-w-0", fieldDensityClassNames(density).stack)}
    >
      <Checkbox
        appearance="card"
        density={density}
        description={description}
        checked={checked}
        disabled={disabled}
        required={required}
        onCheckedChange={onCheckedChange}
      >
        <span className="flex items-center justify-between gap-3">
          {label}
          {required ? <FieldRequiredMark density={density} /> : null}
        </span>
      </Checkbox>
      <FieldError density={density} error={error} />
    </BaseField.Root>
  );
}
