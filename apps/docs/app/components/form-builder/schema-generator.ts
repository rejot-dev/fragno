import type {
  FormField,
  FormBuilderState,
  GeneratedSchemas,
  JsonSchemaProperty,
  UiSchemaElement,
  DataSchema,
} from "./types";

/**
 * Converts a single field to its JSON Schema property definition.
 */
export function fieldToSchemaProperty(field: FormField): JsonSchemaProperty {
  const base: JsonSchemaProperty = {
    type: "string",
    title: field.label,
  };

  if (field.description) {
    base.description = field.description;
  }

  switch (field.fieldType) {
    case "text":
      return { ...base, type: "string" };

    case "textarea":
      return { ...base, type: "string" };

    case "number":
      return {
        ...base,
        type: "number",
        ...(field.options?.minimum !== undefined && { minimum: field.options.minimum }),
        ...(field.options?.maximum !== undefined && { maximum: field.options.maximum }),
      };

    case "integer":
      return {
        ...base,
        type: "integer",
        ...(field.options?.minimum !== undefined && { minimum: field.options.minimum }),
        ...(field.options?.maximum !== undefined && { maximum: field.options.maximum }),
      };

    case "slider": {
      const min = field.options?.minimum;
      const max = field.options?.maximum;
      return {
        ...base,
        type: "number",
        minimum: min,
        maximum: max,
        default: min,
      };
    }

    case "email":
      return { ...base, type: "string", format: "email" };

    case "boolean":
      return { ...base, type: "boolean" };

    case "date":
      return { ...base, type: "string", format: "date" };

    case "time":
      return { ...base, type: "string", format: "time" };

    case "datetime":
      return { ...base, type: "string", format: "date-time" };

    case "select":
      return {
        ...base,
        type: "string",
        enum: field.options?.enumValues ?? [],
      };

    default:
      return base;
  }
}

/**
 * Converts a single field to its UI Schema control element.
 */
export function fieldToUiSchemaElement(field: FormField): UiSchemaElement {
  const control: UiSchemaElement = {
    type: "Control",
    scope: `#/properties/${field.fieldName}`,
  };

  // Add type-specific UI options
  const options: Record<string, unknown> = {};

  if (field.fieldType === "textarea") {
    options.multi = true;
  }

  if (field.fieldType === "slider") {
    options.slider = true;
  }

  if (field.options?.placeholder) {
    options.placeholder = field.options.placeholder;
  }

  if (Object.keys(options).length > 0) {
    control.options = options;
  }

  return control;
}

/**
 * Generates JSON Schema and UI Schema from form builder state.
 */
export function generateSchemas(state: FormBuilderState): GeneratedSchemas {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  const uiElements: UiSchemaElement[] = [];

  for (const field of state.fields) {
    // Skip fields without a valid field name
    if (!field.fieldName) {
      continue;
    }

    properties[field.fieldName] = fieldToSchemaProperty(field);

    if (field.required) {
      required.push(field.fieldName);
    }

    uiElements.push(fieldToUiSchemaElement(field));
  }

  const dataSchema: DataSchema = {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
  };

  const uiSchema: UiSchemaElement = {
    type: "VerticalLayout",
    elements: uiElements,
  };

  return { dataSchema, uiSchema };
}

/**
 * Generates a valid field name from a label.
 * Converts to lowercase, replaces non-alphanumeric with underscore.
 */
export function labelToFieldName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_") // Replace non-alphanumeric with underscore
      .replace(/^_+|_+$/g, "") // Trim leading/trailing underscores
      .replace(/_+/g, "_") || // Collapse multiple underscores
    "field"
  );
}

/**
 * Ensures a field name is unique within the form.
 * Appends a number suffix if the name already exists.
 */
export function ensureUniqueFieldName(baseName: string, existingNames: string[]): string {
  let name = baseName;
  let counter = 1;

  while (existingNames.includes(name)) {
    name = `${baseName}_${counter}`;
    counter++;
  }

  return name;
}
