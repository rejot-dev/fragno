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
  | "select"
  | "label"
  | "unsupported";

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
  /** Default value for slider fields */
  defaultValue?: number;
  /** Placeholder text for text/textarea fields */
  placeholder?: string;
  /** Raw JSON Schema for unsupported field types */
  rawJsonSchema?: string;
  /** Raw UI Schema for unsupported field types */
  rawUiSchema?: string;
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
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  /** Nested properties for object types */
  properties?: Record<string, JsonSchemaProperty>;
  /** Required fields for object types */
  required?: string[];
  /** Items schema for array types */
  items?: JsonSchemaProperty;
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
  type: "Control" | "VerticalLayout" | "HorizontalLayout" | "Group" | "Label";
  scope?: string;
  elements?: UiSchemaElement[];
  options?: Record<string, unknown>;
  /** Text content for Label elements */
  text?: string;
}

/**
 * Generated schemas from the form builder.
 */
export interface GeneratedSchemas {
  dataSchema: DataSchema;
  uiSchema: UiSchemaElement;
}
