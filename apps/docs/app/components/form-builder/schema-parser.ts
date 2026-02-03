import type {
  FormField,
  FormBuilderState,
  GeneratedSchemas,
  JsonSchemaProperty,
  UiSchemaElement,
  FieldType,
  FieldOptions,
} from "./types";

/**
 * Extracts the field name from a UI Schema control scope.
 * E.g., "#/properties/email" -> "email"
 */
function extractFieldNameFromScope(scope: string): string | null {
  const match = scope.match(/^#\/properties\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Recursively collects all Control and Label elements from a UI schema tree.
 * Supports nested layouts (VerticalLayout, HorizontalLayout, Group, etc.)
 */
function collectUiElements(element: UiSchemaElement): UiSchemaElement[] {
  const elements: UiSchemaElement[] = [];

  if (element.type === "Control" || element.type === "Label") {
    elements.push(element);
  }

  if (element.elements) {
    for (const child of element.elements) {
      elements.push(...collectUiElements(child));
    }
  }

  return elements;
}

/**
 * Converts a fieldName to a human-readable label.
 * E.g., "user_email" -> "User Email"
 */
function fieldNameToLabel(fieldName: string): string {
  return fieldName
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Checks if a JSON Schema property type is supported by the form builder.
 */
function isSupportedType(type: JsonSchemaProperty["type"]): boolean {
  return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

/**
 * Infers the FieldType from a JSON Schema property and UI Schema options.
 * Returns "unsupported" for types that can't be represented in the builder.
 */
function inferFieldType(prop: JsonSchemaProperty, uiOptions?: Record<string, unknown>): FieldType {
  if (!isSupportedType(prop.type)) {
    return "unsupported";
  }

  if (uiOptions?.multi === true && prop.type === "string") {
    return "textarea";
  }

  if (uiOptions?.slider === true && (prop.type === "number" || prop.type === "integer")) {
    return "slider";
  }

  if (prop.type === "string" && prop.enum && prop.enum.length > 0) {
    return "select";
  }

  if (prop.type === "string" && prop.format) {
    switch (prop.format) {
      case "email":
        return "email";
      case "date":
        return "date";
      case "time":
        return "time";
      case "date-time":
        return "datetime";
      default:
        return "unsupported";
    }
  }

  switch (prop.type) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    default:
      return "unsupported";
  }
}

/**
 * Parses a single JSON Schema property into a FormField.
 */
function parseSchemaProperty(
  fieldName: string,
  prop: JsonSchemaProperty,
  uiElement?: UiSchemaElement,
  isRequired?: boolean,
): FormField {
  const uiOptions = uiElement?.options;
  const fieldType = inferFieldType(prop, uiOptions);
  const options: FieldOptions = {};

  if (fieldType === "unsupported") {
    options.rawJsonSchema = JSON.stringify(prop, null, 2);
    if (uiElement) {
      options.rawUiSchema = JSON.stringify(uiElement, null, 2);
    }
  }

  if (prop.enum && prop.enum.length > 0) {
    options.enumValues = [...prop.enum];
  }

  if (prop.minimum !== undefined) {
    options.minimum = prop.minimum;
  }

  if (prop.maximum !== undefined) {
    options.maximum = prop.maximum;
  }

  if (uiOptions?.placeholder && typeof uiOptions.placeholder === "string") {
    options.placeholder = uiOptions.placeholder;
  }

  if (fieldType === "slider" && typeof prop.default === "number") {
    options.defaultValue = prop.default;
  }

  return {
    id: crypto.randomUUID(),
    fieldName,
    label: prop.title ?? fieldNameToLabel(fieldName),
    description: prop.description,
    fieldType,
    required: isRequired ?? false,
    options: Object.keys(options).length > 0 ? options : undefined,
  };
}

/**
 * Parses GeneratedSchemas back into FormBuilderState.
 * This is the inverse of generateSchemas.
 */
export function parseSchemas(schemas: GeneratedSchemas): FormBuilderState {
  const { dataSchema, uiSchema } = schemas;
  const fields: FormField[] = [];
  const allElements = collectUiElements(uiSchema);
  const requiredFields = new Set(dataSchema.required ?? []);
  const propertyNamesInUi = new Set<string>();
  const usedLabelNames = new Set(Object.keys(dataSchema.properties));
  let labelIndex = 1;

  const createLabelFieldName = () => {
    let candidate = `label_${labelIndex}`;
    while (usedLabelNames.has(candidate)) {
      labelIndex += 1;
      candidate = `label_${labelIndex}`;
    }
    usedLabelNames.add(candidate);
    labelIndex += 1;
    return candidate;
  };

  for (const element of allElements) {
    if (element.type === "Label") {
      fields.push({
        id: crypto.randomUUID(),
        fieldName: createLabelFieldName(),
        label: element.text ?? "Label",
        fieldType: "label",
        required: false,
      });
      continue;
    }

    if (element.scope) {
      const fieldName = extractFieldNameFromScope(element.scope);
      const prop = fieldName ? dataSchema.properties[fieldName] : undefined;
      if (!fieldName || !prop) {
        continue;
      }

      propertyNamesInUi.add(fieldName);
      fields.push(parseSchemaProperty(fieldName, prop, element, requiredFields.has(fieldName)));
    }
  }

  for (const fieldName of Object.keys(dataSchema.properties)) {
    if (!propertyNamesInUi.has(fieldName)) {
      const prop = dataSchema.properties[fieldName];
      fields.push(parseSchemaProperty(fieldName, prop, undefined, requiredFields.has(fieldName)));
    }
  }

  return { fields };
}
