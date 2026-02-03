/**
 * Field types supported by the form builder.
 * Maps to JSON Schema types and formats.
 */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "integer"
  | "slider"
  | "email"
  | "boolean"
  | "date"
  | "time"
  | "datetime"
  | "select";

/**
 * Type-specific configuration options for a field.
 */
export interface FieldOptions {
  /** Options for select/dropdown fields */
  enumValues?: string[];
  /** Minimum value for number/integer fields */
  minimum?: number;
  /** Maximum value for number/integer fields */
  maximum?: number;
  /** Placeholder text for text/textarea fields */
  placeholder?: string;
}

/**
 * Represents a single field in the form builder.
 */
export interface FormField {
  /** Unique identifier for this field */
  id: string;
  /** Property name in the generated JSON Schema */
  fieldName: string;
  /** Display label for the field */
  label: string;
  /** Optional help text / description */
  description?: string;
  /** The type of field */
  fieldType: FieldType;
  /** Whether the field is required */
  required: boolean;
  /** Type-specific options */
  options?: FieldOptions;
}

/**
 * State of the form builder.
 */
export interface FormBuilderState {
  fields: FormField[];
}

/**
 * JSON Schema property definition (subset of JSON Schema).
 */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  title?: string;
  description?: string;
  format?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/**
 * JSON Schema for the form data.
 */
export interface DataSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * UI Schema element (Control or Layout).
 */
export interface UiSchemaElement {
  type: "Control" | "VerticalLayout" | "HorizontalLayout" | "Group";
  scope?: string;
  elements?: UiSchemaElement[];
  options?: Record<string, unknown>;
}

/**
 * Generated schemas from the form builder.
 */
export interface GeneratedSchemas {
  dataSchema: DataSchema;
  uiSchema: UiSchemaElement;
}
