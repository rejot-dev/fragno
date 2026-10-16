import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";

import { cn } from "../cn";
import { fieldControlClassName, type FieldDensity } from "./field";

// Multi-line text field on the shared .bo-input surface; rows sets its resting height. Inside a
// Field it picks up the field's label, description, and invalid state.
export function TextArea({
  className,
  density,
  ...props
}: ComponentProps<"textarea"> & { density: FieldDensity }) {
  return (
    <BaseField.Control
      render={(fieldProps) => (
        <textarea
          {...fieldProps}
          {...props}
          className={cn(
            "bo-input w-full resize-y py-2.5 leading-5",
            fieldControlClassName(density),
            className,
          )}
        />
      )}
    />
  );
}
