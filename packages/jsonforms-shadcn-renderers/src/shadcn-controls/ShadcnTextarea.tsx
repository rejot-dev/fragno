import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo } from "react";
import { Textarea } from "@/components/ui/textarea";

type ShadcnTextareaProps = CellProps & WithClassname;

export const ShadcnTextarea = memo(function ShadcnTextarea(props: ShadcnTextareaProps) {
  const { data, className, id, enabled, path, handleChange, schema } = props;

  return (
    <Textarea
      value={data ?? ""}
      onChange={(e) => handleChange(path, e.target.value || undefined)}
      className={className}
      id={id}
      disabled={!enabled}
      maxLength={schema.maxLength}
    />
  );
});
