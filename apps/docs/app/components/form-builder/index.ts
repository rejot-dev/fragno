// Main component
export { FormBuilder } from "./form-builder";
export type { FormBuilderProps } from "./form-builder";

// Types
export type {
  FieldType,
  FieldOptions as FieldOptionsType,
  FormField,
  FormBuilderState,
  GeneratedSchemas,
  DataSchema,
  UiSchemaElement,
  JsonSchemaProperty,
} from "./types";

// Schema generation utilities
export {
  generateSchemas,
  fieldToSchemaProperty,
  fieldToUiSchemaElement,
  labelToFieldName,
  ensureUniqueFieldName,
} from "./schema-generator";

// Hook for custom implementations
export { useFormBuilder } from "./use-form-builder";

// Constants
export { FIELD_TYPES, getFieldTypeConfig } from "./constants";
export type { FieldTypeConfig } from "./constants";

// Sub-components for composition
export { FieldCard } from "./field-card";
export type { FieldCardProps } from "./field-card";
export { FieldTypeSelector } from "./field-type-selector";
export type { FieldTypeSelectorProps } from "./field-type-selector";
export { FieldOptions } from "./field-options";
export type { FieldOptionsProps } from "./field-options";
export { EnumValuesEditor } from "./enum-values-editor";
export type { EnumValuesEditorProps } from "./enum-values-editor";

// Form metadata (forms-fragment specific, can be removed if not using @fragno-dev/forms)
export { FormMetadataEditor } from "./form-metadata";
export type { FormMetadataEditorProps, FormMetadata, FormStatus } from "./form-metadata";
