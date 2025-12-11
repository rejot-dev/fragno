import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { formatTimeForSave, toTimeInputValue } from "../util/date-time";

type ShadcnTimePickerProps = CellProps & WithClassname;

export const ShadcnTimePicker = memo(function ShadcnTimePicker(props: ShadcnTimePickerProps) {
  const { data, className, id, enabled, path, handleChange } = props;

  const inputValue = useMemo(() => toTimeInputValue(data), [data]);

  return (
    <Input
      type="time"
      id={id}
      value={inputValue}
      onChange={(e) => handleChange(path, formatTimeForSave(e.target.value))}
      disabled={!enabled}
      className={cn(
        "bg-background w-full appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none",
        className,
      )}
    />
  );
});
