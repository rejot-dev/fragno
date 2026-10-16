import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

import { cn } from "../cn";
import { fieldControlClassName, type FieldDensity } from "./field";

// Only text-entry types: checkboxes, radios, files, and hidden fields have their own controls and
// must not pick up the field surface.
export type InputType =
  | "text"
  | "email"
  | "password"
  | "url"
  | "search"
  | "tel"
  | "number"
  | "date"
  | "time"
  | "datetime-local"
  | "month";

// Single-line text field on the shared .bo-input surface. Width is left to the caller because
// fields sit both in stacked forms (full width) and inline next to actions (intrinsic width).
// Inside a Field it picks up the field's label, description, and invalid state.
export function Input({
  className,
  density = "default",
  type = "text",
  ...props
}: Omit<ComponentProps<"input">, "type"> & { density?: FieldDensity; type?: InputType }) {
  return (
    <BaseInput
      type={type}
      className={cn("bo-input py-2", fieldControlClassName(density), className)}
      {...props}
    />
  );
}
