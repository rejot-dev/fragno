import type { CellProps, WithClassname, EnumOption } from "@jsonforms/core";
import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ShadcnSelectProps = CellProps &
  WithClassname & {
    options: EnumOption[];
  };

export const ShadcnSelect = memo(function ShadcnSelect(props: ShadcnSelectProps) {
  const { data, className, id, enabled, path, handleChange, options } = props;

  return (
    <Select
      value={data ?? ""}
      onValueChange={(value) => handleChange(path, value || undefined)}
      disabled={!enabled}
    >
      <SelectTrigger id={id} className={cn("w-full", className)}>
        <SelectValue placeholder="Select an option" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={String(option.value)} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
