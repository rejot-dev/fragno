import type { CellProps, WithClassname, EnumOption } from "@jsonforms/core";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type ShadcnRadioGroupProps = CellProps &
  WithClassname & {
    options: EnumOption[];
  };

export const ShadcnRadioGroup = memo(function ShadcnRadioGroup(props: ShadcnRadioGroupProps) {
  const { data, className, id, enabled, path, handleChange, options } = props;

  return (
    <RadioGroup
      value={data ?? ""}
      onValueChange={(value) => handleChange(path, value || undefined)}
      disabled={!enabled}
      className={cn("flex flex-col gap-2", className)}
    >
      {options.map((option) => {
        const optionId = `${id}-${String(option.value)}`;
        return (
          <div key={String(option.value)} className="flex items-center gap-2">
            <RadioGroupItem value={String(option.value)} id={optionId} />
            <Label htmlFor={optionId} className="font-normal">
              {option.label}
            </Label>
          </div>
        );
      })}
    </RadioGroup>
  );
});
