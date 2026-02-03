import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FIELD_TYPES } from "./constants";
import type { FieldType } from "./types";

export interface FieldTypeSelectorProps {
  value: FieldType;
  onChange: (type: FieldType) => void;
}

export function FieldTypeSelector({ value, onChange }: FieldTypeSelectorProps) {
  return (
    // Cast is safe: select options are constrained to FieldType values
    <Select value={value} onValueChange={(v) => onChange(v as FieldType)}>
      <SelectTrigger data-slot="field-type-selector" className="w-[180px]">
        <SelectValue placeholder="Select type" />
      </SelectTrigger>
      <SelectContent>
        {FIELD_TYPES.map((fieldType) => {
          const Icon = fieldType.icon;
          return (
            <SelectItem key={fieldType.type} value={fieldType.type}>
              <span className="flex items-center gap-2">
                <Icon className="text-muted-foreground size-4" />
                <span>{fieldType.label}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
