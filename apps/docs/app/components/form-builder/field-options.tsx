import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

  if (fieldType === "label") {
    return null;
  }

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

  if (fieldType === "slider") {
    const defaults = getFieldTypeConfig("slider")?.defaultOptions;
    const defaultMin = defaults?.minimum ?? 1;
    const defaultMax = defaults?.maximum ?? 10;
    const defaultValue = defaults?.defaultValue ?? defaultMin;
    return (
      <div data-slot="field-options" className={cn("border-t pt-4", className)}>
        <div className="grid grid-cols-3 gap-4">
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
            <Label htmlFor="default-value" className="text-muted-foreground text-sm">
              Default
            </Label>
            <Input
              id="default-value"
              type="number"
              value={options?.defaultValue ?? defaultValue}
              onChange={(e) => {
                const value = Number(e.target.value);
                updateOption("defaultValue", Number.isNaN(value) ? defaultValue : value);
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

  if (fieldType === "unsupported") {
    return (
      <div data-slot="field-options" className={cn("space-y-4 border-t pt-4", className)}>
        <div className="space-y-2">
          <Label htmlFor="raw-json-schema" className="text-muted-foreground text-sm">
            JSON Schema
          </Label>
          <Textarea
            id="raw-json-schema"
            className="font-mono text-xs"
            rows={6}
            placeholder="{}"
            value={options?.rawJsonSchema ?? "{}"}
            onChange={(e) => updateOption("rawJsonSchema", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="raw-ui-schema" className="text-muted-foreground text-sm">
            UI Schema
          </Label>
          <Textarea
            id="raw-ui-schema"
            className="font-mono text-xs"
            rows={4}
            placeholder="{}"
            value={options?.rawUiSchema ?? "{}"}
            onChange={(e) => updateOption("rawUiSchema", e.target.value)}
          />
        </div>
      </div>
    );
  }

  return null;
}
