import { memo } from "react";

import type { CellProps, WithClassname } from "@jsonforms/core";

import { Switch } from "@/components/ui/switch";

type ShadcnSwitchProps = CellProps & WithClassname;

export const ShadcnSwitch = memo(function ShadcnSwitch(props: ShadcnSwitchProps) {
  const { data, className, id, enabled, path } = props;
  const checked = !!data;

  return (
    <Switch
      checked={checked}
      onCheckedChange={(isChecked) => props.handleChange(path, isChecked)}
      className={className}
      id={id}
      disabled={!enabled}
    />
  );
});
