import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EnumValuesEditor } from "./enum-values-editor";
import { getFieldTypeConfig } from "./constants";
import type { FieldType, FieldOptions as FieldOptionsType } from "./types";
import { cn } from "@/lib/utils";

export interface FieldOptionsProps {
  fieldType: FieldType;
  options: FieldOptionsType | undefined;
  onChange: (options: FieldOptionsType) => void;
  className?: string;
}

export function FieldOptions({ fieldType, options, onChange, className }: FieldOptionsProps) {
  const updateOption = <K extends keyof FieldOptionsType>(key: K, value: FieldOptionsType[K]) => {
    onChange({ ...options, [key]: value });
  };

  // Select field: show enum values editor
  if (fieldType === "select") {
    return (
      <div data-slot="field-options" className={cn("border-t pt-4", className)}>
        <EnumValuesEditor
          values={options?.enumValues ?? ["Option 1"]}
          onChange={(enumValues) => updateOption("enumValues", enumValues)}
        />
      </div>
    );
  }

  // Slider fields: show min/max (required)
  if (fieldType === "slider") {
    const defaults = getFieldTypeConfig("slider")?.defaultOptions;
    const defaultMin = defaults?.minimum ?? 1;
    const defaultMax = defaults?.maximum ?? 10;
    return (
      <div data-slot="field-options" className={cn("border-t pt-4", className)}>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="min-value" className="text-muted-foreground text-sm">
              Minimum
            </Label>
            <Input
              id="min-value"
              type="number"
              value={options?.minimum ?? defaultMin}
              onChange={(e) => {
                const value = Number(e.target.value);
                updateOption("minimum", Number.isNaN(value) ? defaultMin : value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="max-value" className="text-muted-foreground text-sm">
              Maximum
            </Label>
            <Input
              id="max-value"
              type="number"
              value={options?.maximum ?? defaultMax}
              onChange={(e) => {
                const value = Number(e.target.value);
                updateOption("maximum", Number.isNaN(value) ? defaultMax : value);
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Number/Integer fields: show min/max (optional)
  if (fieldType === "number" || fieldType === "integer") {
    return (
      <div data-slot="field-options" className={cn("border-t pt-4", className)}>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="min-value" className="text-muted-foreground text-sm">
              Minimum
            </Label>
            <Input
              id="min-value"
              type="number"
              placeholder="No minimum"
              value={options?.minimum ?? ""}
              onChange={(e) =>
                updateOption("minimum", e.target.value ? Number(e.target.value) : undefined)
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="max-value" className="text-muted-foreground text-sm">
              Maximum
            </Label>
            <Input
              id="max-value"
              type="number"
              placeholder="No maximum"
              value={options?.maximum ?? ""}
              onChange={(e) =>
                updateOption("maximum", e.target.value ? Number(e.target.value) : undefined)
              }
            />
          </div>
        </div>
      </div>
    );
  }

  // Text/Textarea fields: show placeholder
  if (fieldType === "text" || fieldType === "textarea") {
    return (
      <div data-slot="field-options" className={cn("border-t pt-4", className)}>
        <div className="space-y-2">
          <Label htmlFor="placeholder" className="text-muted-foreground text-sm">
            Placeholder
          </Label>
          <Input
            id="placeholder"
            placeholder="Enter placeholder text"
            value={options?.placeholder ?? ""}
            onChange={(e) => updateOption("placeholder", e.target.value || undefined)}
          />
        </div>
      </div>
    );
  }

  // No options for other field types
  return null;
}
