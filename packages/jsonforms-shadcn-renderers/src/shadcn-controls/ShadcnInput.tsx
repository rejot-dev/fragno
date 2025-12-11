import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo } from "react";
import { Input } from "@/components/ui/input";

type ShadcnInputProps = Pick<
  CellProps,
  "data" | "id" | "enabled" | "path" | "handleChange" | "schema"
> &
  WithClassname;

export const ShadcnInput = memo(function ShadcnInput(props: ShadcnInputProps) {
  const { data, className, id, enabled, path, handleChange, schema } = props;

  return (
    <Input
      type="text"
      value={data ?? ""}
      onChange={(e) => handleChange(path, e.target.value || undefined)}
      className={className}
      id={id}
      disabled={!enabled}
      maxLength={schema.maxLength}
    />
  );
});
