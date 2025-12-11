import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo } from "react";
import { Switch } from "@/components/ui/switch";

type ShadcnSwitchProps = CellProps & WithClassname;

export const ShadcnSwitch = memo(function ShadcnSwitch(props: ShadcnSwitchProps) {
  const { data, className, id, enabled, path, handleChange } = props;
  const checked = !!data;

  return (
    <Switch
      checked={checked}
      onCheckedChange={(isChecked) => handleChange(path, isChecked)}
      className={className}
      id={id}
      disabled={!enabled}
    />
  );
});
