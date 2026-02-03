import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface EnumValuesEditorProps {
  values: string[];
  onChange: (values: string[]) => void;
  className?: string;
}

export function EnumValuesEditor({ values, onChange, className }: EnumValuesEditorProps) {
  const addOption = () => {
    onChange([...values, `Option ${values.length + 1}`]);
  };

  const updateOption = (index: number, value: string) => {
    const newValues = [...values];
    newValues[index] = value;
    onChange(newValues);
  };

  const deleteOption = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  const moveOption = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= values.length) {
      return;
    }
    const newValues = [...values];
    const [removed] = newValues.splice(fromIndex, 1);
    newValues.splice(toIndex, 0, removed);
    onChange(newValues);
  };

  return (
    <div data-slot="enum-values-editor" className={cn("space-y-2", className)}>
      <div className="text-muted-foreground text-sm font-medium">Options</div>
      <div className="space-y-2">
        {values.map((value, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="text-muted-foreground w-4 text-xs">{index + 1}.</span>
            <Input
              value={value}
              onChange={(e) => updateOption(index, e.target.value)}
              placeholder={`Option ${index + 1}`}
              className="flex-1"
            />
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => moveOption(index, index - 1)}
                disabled={index === 0}
              >
                <ChevronUp className="size-4" />
                <span className="sr-only">Move up</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => moveOption(index, index + 1)}
                disabled={index === values.length - 1}
              >
                <ChevronDown className="size-4" />
                <span className="sr-only">Move down</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive size-8"
                onClick={() => deleteOption(index)}
                disabled={values.length <= 1}
              >
                <Trash2 className="size-4" />
                <span className="sr-only">Delete option</span>
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={addOption} className="w-full">
        <Plus className="mr-2 size-4" />
        Add Option
      </Button>
    </div>
  );
}
