import type { ComponentProps } from "react";

import { cn } from "../cn";

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
export function Input({
  className,
  type = "text",
  ...props
}: Omit<ComponentProps<"input">, "type"> & { type?: InputType }) {
  return (
    <input
      type={type}
      className={cn("bo-input min-h-11 px-3 py-2 text-sm", className)}
      {...props}
    />
  );
}
