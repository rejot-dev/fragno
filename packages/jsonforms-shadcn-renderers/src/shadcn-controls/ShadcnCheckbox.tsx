import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo } from "react";
import { Checkbox } from "@/components/ui/checkbox";

type ShadcnCheckboxProps = CellProps & WithClassname;

export const ShadcnCheckbox = memo(function ShadcnCheckbox(props: ShadcnCheckboxProps) {
  const { data, className, id, enabled, path, handleChange } = props;
  const checked = !!data;

  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(isChecked) => handleChange(path, isChecked === true)}
      className={className}
      id={id}
      disabled={!enabled}
    />
  );
});
