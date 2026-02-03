import { ChevronUp, ChevronDown, Copy, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FieldTypeSelector } from "./field-type-selector";
import { FieldOptions } from "./field-options";
import { getFieldTypeConfig } from "./constants";
import type { FormField, FieldType } from "./types";
import { cn } from "@/lib/utils";

export interface FieldCardProps {
  field: FormField;
  index: number;
  totalCount: number;
  onUpdate: (updates: Partial<Omit<FormField, "id">>) => void;
  onUpdateLabel: (label: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  className?: string;
}

export function FieldCard({
  field,
  index,
  totalCount,
  onUpdate,
  onUpdateLabel,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  className,
}: FieldCardProps) {
  const handleTypeChange = (fieldType: FieldType) => {
    const typeConfig = getFieldTypeConfig(fieldType);
    onUpdate({
      fieldType,
      options: typeConfig?.defaultOptions ? { ...typeConfig.defaultOptions } : undefined,
    });
  };

  return (
    <Card data-slot="field-card" className={cn("relative", className)}>
      <CardContent className="pt-6">
        {/* Field number badge */}
        <div className="bg-background text-muted-foreground absolute -top-3 left-4 px-2 text-xs font-medium">
          Field {index + 1}
        </div>

        {/* Main content */}
        <div className="space-y-4">
          {/* Top row: Label + Type */}
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1 space-y-2">
              <Label htmlFor={`field-label-${field.id}`}>Label</Label>
              <Input
                id={`field-label-${field.id}`}
                value={field.label}
                onChange={(e) => onUpdateLabel(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <FieldTypeSelector value={field.fieldType} onChange={handleTypeChange} />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor={`field-description-${field.id}`}>
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id={`field-description-${field.id}`}
              value={field.description ?? ""}
              onChange={(e) => onUpdate({ description: e.target.value || undefined })}
            />
          </div>

          {/* Required toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id={`field-required-${field.id}`}
                checked={field.required}
                onCheckedChange={(checked) => onUpdate({ required: checked })}
              />
              <Label htmlFor={`field-required-${field.id}`} className="cursor-pointer">
                Required
              </Label>
            </div>

            {/* Action buttons */}
            <TooltipProvider>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={onMoveUp}
                      disabled={!onMoveUp}
                    >
                      <ChevronUp className="size-4" />
                      <span className="sr-only">Move up</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Move up</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={onMoveDown}
                      disabled={!onMoveDown}
                    >
                      <ChevronDown className="size-4" />
                      <span className="sr-only">Move down</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Move down</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={onDuplicate}
                    >
                      <Copy className="size-4" />
                      <span className="sr-only">Duplicate</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Duplicate</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive size-8"
                      onClick={onDelete}
                      disabled={totalCount <= 1}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          </div>

          {/* Type-specific options */}
          <FieldOptions
            fieldType={field.fieldType}
            options={field.options}
            onChange={(options) => onUpdate({ options })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
