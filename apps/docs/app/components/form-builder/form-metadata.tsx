import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type FormStatus = "draft" | "open" | "closed";

export interface FormMetadata {
  title: string;
  description: string;
  status: FormStatus;
}

export interface FormMetadataEditorProps {
  value: FormMetadata;
  onChange: (metadata: FormMetadata) => void;
  className?: string;
}

const STATUS_OPTIONS: { value: FormStatus; label: string; description: string }[] = [
  { value: "draft", label: "Draft", description: "Not accepting submissions" },
  { value: "open", label: "Open", description: "Accepting submissions" },
  { value: "closed", label: "Closed", description: "No longer accepting submissions" },
];

export function FormMetadataEditor({ value, onChange, className }: FormMetadataEditorProps) {
  const updateField = <K extends keyof FormMetadata>(key: K, fieldValue: FormMetadata[K]) => {
    onChange({ ...value, [key]: fieldValue });
  };

  return (
    <div data-slot="form-metadata-editor" className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <Label htmlFor="form-title">Form Title</Label>
        <Input
          id="form-title"
          value={value.title}
          onChange={(e) => updateField("title", e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="form-description">
          Description <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id="form-description"
          value={value.description}
          onChange={(e) => updateField("description", e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="form-status">Status</Label>
        {/* Cast is safe: select options are constrained to FormStatus values */}
        <Select value={value.status} onValueChange={(v) => updateField("status", v as FormStatus)}>
          <SelectTrigger id="form-status">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
