import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";

import { cn } from "../cn";
import { fieldDensityClassNames, type FieldDensity } from "./field-density";

// Multi-line text field on the shared .bo-input surface; rows sets its resting height. Inside a
// Field it picks up the field's label, description, and invalid state.
export function TextArea({
  className,
  density = "default",
  ...props
}: ComponentProps<"textarea"> & { density?: FieldDensity }) {
  return (
    <BaseField.Control
      render={(fieldProps) => (
        <textarea
          {...fieldProps}
          {...props}
          className={cn(
            "bo-input w-full resize-y py-2.5 leading-5",
            fieldDensityClassNames(density).control,
            className,
          )}
        />
      )}
    />
  );
}
