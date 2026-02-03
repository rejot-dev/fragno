import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldCard } from "./field-card";
import { useFormBuilder } from "./use-form-builder";
import type { FormBuilderState, GeneratedSchemas, FieldType } from "./types";
import { cn } from "@/lib/utils";

export interface FormBuilderProps {
  /** Initial state for the form builder (takes precedence over defaultSchemas) */
  defaultValue?: FormBuilderState;
  /** Initialize from existing schemas (parsed into FormBuilderState) */
  defaultSchemas?: GeneratedSchemas;
  /** Callback when schemas change */
  onChange?: (schemas: GeneratedSchemas) => void;
  /** Additional class name */
  className?: string;
}

export function FormBuilder({
  defaultValue,
  defaultSchemas,
  onChange,
  className,
}: FormBuilderProps) {
  const {
    state,
    addField,
    updateField,
    deleteField,
    moveField,
    duplicateField,
    updateFieldNameFromLabel,
  } = useFormBuilder({ initialState: defaultValue, initialSchemas: defaultSchemas, onChange });

  const handleAddField = (fieldType?: FieldType) => {
    addField(fieldType);
  };

  return (
    <div data-slot="form-builder" className={cn("space-y-6", className)}>
      {state.fields.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-muted-foreground">
            No fields yet. Add your first field to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {state.fields.map((field, index) => (
            <FieldCard
              key={field.id}
              field={field}
              index={index}
              onUpdate={(updates) => updateField(field.id, updates)}
              onUpdateLabel={(label) => updateFieldNameFromLabel(field.id, label)}
              onDelete={() => deleteField(field.id)}
              onDuplicate={() => duplicateField(field.id)}
              onMoveUp={index > 0 ? () => moveField(index, index - 1) : undefined}
              onMoveDown={
                index < state.fields.length - 1 ? () => moveField(index, index + 1) : undefined
              }
            />
          ))}
        </div>
      )}

      <Button type="button" variant="outline" className="w-full" onClick={() => handleAddField()}>
        <Plus className="mr-2 size-4" />
        Add Field
      </Button>
    </div>
  );
}
