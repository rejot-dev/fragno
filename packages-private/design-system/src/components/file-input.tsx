import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";

import { cn } from "../cn";
import { fieldDensityClassNames, type FieldDensity } from "./field-density";

// Native file picker on the shared .bo-input surface. Inside a Field it picks up the field's label
// and description; its own aria-describedby (for example an upload status) is appended to them.
export function FileInput({
  "aria-describedby": ariaDescribedBy,
  className,
  density = "default",
  ...props
}: Omit<ComponentProps<"input">, "type"> & { density?: FieldDensity }) {
  return (
    <BaseField.Control
      {...props}
      type="file"
      render={(fieldProps) => (
        <input
          {...fieldProps}
          aria-describedby={
            [fieldProps["aria-describedby"], ariaDescribedBy].filter(Boolean).join(" ") || undefined
          }
        />
      )}
      className={cn(
        "bo-input w-full py-2 text-[var(--bo-fg)] file:mr-3 file:border-0 file:bg-transparent file:font-semibold file:text-[var(--bo-fg)]",
        fieldDensityClassNames(density).control,
        className,
      )}
    />
  );
}
