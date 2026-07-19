import { memo } from "react";

import type { CellProps, WithClassname } from "@jsonforms/core";

import { Checkbox } from "@/components/ui/checkbox";

type ShadcnCheckboxProps = CellProps & WithClassname;

export const ShadcnCheckbox = memo(function ShadcnCheckbox(props: ShadcnCheckboxProps) {
  const { data, className, id, enabled, path } = props;
  const checked = !!data;

  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(isChecked) => props.handleChange(path, isChecked === true)}
      className={className}
      id={id}
      disabled={!enabled}
    />
  );
});
