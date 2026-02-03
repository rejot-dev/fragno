import {
  Type,
  AlignLeft,
  Hash,
  SlidersHorizontal,
  Mail,
  CheckSquare,
  Calendar,
  Clock,
  CalendarClock,
  List,
  Code,
  Tag,
} from "lucide-react";
import type { FieldType, FieldOptions } from "./types";

/**
 * Configuration for a field type in the form builder.
 */
export interface FieldTypeConfig {
  type: FieldType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  defaultOptions?: FieldOptions;
}

/**
 * All supported field types with their metadata.
 */
export const FIELD_TYPES: FieldTypeConfig[] = [
  {
    type: "text",
    label: "Short Text",
    icon: Type,
    description: "Single line text input",
  },
  {
    type: "textarea",
    label: "Long Text",
    icon: AlignLeft,
    description: "Multi-line text area",
  },
  {
    type: "number",
    label: "Decimal number",
    icon: Hash,
    description: "Allows decimal values",
  },
  {
    type: "integer",
    label: "Whole number",
    icon: Hash,
    description: "Only whole numbers",
  },
  {
    type: "slider",
    label: "Slider",
    icon: SlidersHorizontal,
    description: "Numeric slider input",
    defaultOptions: {
      minimum: 1,
      maximum: 10,
      defaultValue: 1,
    },
  },
  {
    type: "email",
    label: "Email",
    icon: Mail,
    description: "Email address with validation",
  },
  {
    type: "boolean",
    label: "Checkbox",
    icon: CheckSquare,
    description: "Yes/No toggle",
  },
  {
    type: "date",
    label: "Date",
    icon: Calendar,
    description: "Date picker",
  },
  {
    type: "time",
    label: "Time",
    icon: Clock,
    description: "Time picker",
  },
  {
    type: "datetime",
    label: "Date & Time",
    icon: CalendarClock,
    description: "Date and time picker",
  },
  {
    type: "select",
    label: "Dropdown",
    icon: List,
    description: "Select from options",
    defaultOptions: {
      enumValues: ["Option 1", "Option 2", "Option 3"],
    },
  },
  {
    type: "label",
    label: "Label",
    icon: Tag,
    description: "Static label text",
  },
  {
    type: "unsupported",
    label: "Raw Schema",
    icon: Code,
    description: "Form builder cannot display this schema type",
    defaultOptions: {
      rawJsonSchema: "{}",
      rawUiSchema: "{}",
    },
  },
];

/**
 * Get the configuration for a specific field type.
 */
export function getFieldTypeConfig(type: FieldType): FieldTypeConfig | undefined {
  return FIELD_TYPES.find((config) => config.type === type);
}
