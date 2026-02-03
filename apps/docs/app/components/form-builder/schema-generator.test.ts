import { describe, it, expect } from "vitest";
import {
  fieldToSchemaProperty,
  fieldToUiSchemaElement,
  generateSchemas,
  labelToFieldName,
  ensureUniqueFieldName,
} from "./schema-generator";
import type { FormField, FormBuilderState } from "./types";

// Helper to create a minimal field
function createField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "test-id",
    fieldName: "test_field",
    label: "Test Field",
    fieldType: "text",
    required: false,
    ...overrides,
  };
}

describe("fieldToSchemaProperty", () => {
  it("converts text field correctly", () => {
    const field = createField({ fieldType: "text", label: "Name" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Name",
    });
  });

  it("converts textarea field correctly", () => {
    const field = createField({ fieldType: "textarea", label: "Description" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Description",
    });
  });

  it("converts email field with format", () => {
    const field = createField({ fieldType: "email", label: "Email Address" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Email Address",
      format: "email",
    });
  });

  it("converts date field with format", () => {
    const field = createField({ fieldType: "date", label: "Birth Date" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Birth Date",
      format: "date",
    });
  });

  it("converts time field with format", () => {
    const field = createField({ fieldType: "time", label: "Start Time" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Start Time",
      format: "time",
    });
  });

  it("converts datetime field with format", () => {
    const field = createField({ fieldType: "datetime", label: "Event DateTime" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Event DateTime",
      format: "date-time",
    });
  });

  it("converts boolean field correctly", () => {
    const field = createField({ fieldType: "boolean", label: "Subscribe" });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "boolean",
      title: "Subscribe",
    });
  });

  it("converts number field with min/max", () => {
    const field = createField({
      fieldType: "number",
      label: "Price",
      options: { minimum: 0, maximum: 1000 },
    });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "number",
      title: "Price",
      minimum: 0,
      maximum: 1000,
    });
  });

  it("converts integer field with min/max", () => {
    const field = createField({
      fieldType: "integer",
      label: "Age",
      options: { minimum: 0, maximum: 150 },
    });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "integer",
      title: "Age",
      minimum: 0,
      maximum: 150,
    });
  });

  it("converts select field with enum values", () => {
    const field = createField({
      fieldType: "select",
      label: "Country",
      options: { enumValues: ["US", "CA", "MX"] },
    });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Country",
      enum: ["US", "CA", "MX"],
    });
  });

  it("includes description when provided", () => {
    const field = createField({
      fieldType: "text",
      label: "Username",
      description: "Choose a unique username",
    });
    const result = fieldToSchemaProperty(field);

    expect(result).toEqual({
      type: "string",
      title: "Username",
      description: "Choose a unique username",
    });
  });
});

describe("fieldToUiSchemaElement", () => {
  it("generates correct scope path", () => {
    const field = createField({ fieldName: "user_name" });
    const result = fieldToUiSchemaElement(field);

    expect(result.scope).toBe("#/properties/user_name");
    expect(result.type).toBe("Control");
  });

  it("adds multi option for textarea", () => {
    const field = createField({ fieldType: "textarea", fieldName: "bio" });
    const result = fieldToUiSchemaElement(field);

    expect(result.options).toEqual({ multi: true });
  });

  it("adds placeholder option when provided", () => {
    const field = createField({
      fieldType: "text",
      fieldName: "email",
      options: { placeholder: "you@example.com" },
    });
    const result = fieldToUiSchemaElement(field);

    expect(result.options).toEqual({ placeholder: "you@example.com" });
  });

  it("combines multiple options for textarea with placeholder", () => {
    const field = createField({
      fieldType: "textarea",
      fieldName: "message",
      options: { placeholder: "Enter your message..." },
    });
    const result = fieldToUiSchemaElement(field);

    expect(result.options).toEqual({
      multi: true,
      placeholder: "Enter your message...",
    });
  });

  it("returns no options for simple fields", () => {
    const field = createField({ fieldType: "boolean", fieldName: "subscribe" });
    const result = fieldToUiSchemaElement(field);

    expect(result.options).toBeUndefined();
  });
});

describe("generateSchemas", () => {
  it("creates complete schema from fields", () => {
    const state: FormBuilderState = {
      fields: [
        createField({ fieldName: "name", label: "Name", fieldType: "text" }),
        createField({ fieldName: "email", label: "Email", fieldType: "email" }),
      ],
    };
    const result = generateSchemas(state);

    expect(result.dataSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        email: { type: "string", title: "Email", format: "email" },
      },
    });

    expect(result.uiSchema).toEqual({
      type: "VerticalLayout",
      elements: [
        { type: "Control", scope: "#/properties/name" },
        { type: "Control", scope: "#/properties/email" },
      ],
    });
  });

  it("handles required fields", () => {
    const state: FormBuilderState = {
      fields: [
        createField({ fieldName: "name", label: "Name", required: true }),
        createField({ fieldName: "nickname", label: "Nickname", required: false }),
        createField({ fieldName: "email", label: "Email", required: true }),
      ],
    };
    const result = generateSchemas(state);

    expect(result.dataSchema.required).toEqual(["name", "email"]);
  });

  it("skips fields without fieldName", () => {
    const state: FormBuilderState = {
      fields: [
        createField({ fieldName: "name", label: "Name" }),
        createField({ fieldName: "", label: "Empty" }),
        createField({ fieldName: "email", label: "Email" }),
      ],
    };
    const result = generateSchemas(state);

    expect(Object.keys(result.dataSchema.properties)).toEqual(["name", "email"]);
    expect(result.uiSchema.elements).toHaveLength(2);
  });

  it("returns empty schema for no fields", () => {
    const state: FormBuilderState = { fields: [] };
    const result = generateSchemas(state);

    expect(result.dataSchema).toEqual({
      type: "object",
      properties: {},
    });
    expect(result.uiSchema).toEqual({
      type: "VerticalLayout",
      elements: [],
    });
  });
});

describe("labelToFieldName", () => {
  it("converts simple label to lowercase", () => {
    expect(labelToFieldName("Name")).toBe("name");
  });

  it("replaces spaces with underscores", () => {
    expect(labelToFieldName("First Name")).toBe("first_name");
  });

  it("replaces special characters with underscores", () => {
    expect(labelToFieldName("Email (Work)")).toBe("email_work");
  });

  it("collapses multiple underscores", () => {
    expect(labelToFieldName("My   Field")).toBe("my_field");
  });

  it("trims leading/trailing underscores", () => {
    expect(labelToFieldName("  Name  ")).toBe("name");
  });

  it("returns 'field' for empty string", () => {
    expect(labelToFieldName("")).toBe("field");
  });

  it("returns 'field' for only special characters", () => {
    expect(labelToFieldName("---")).toBe("field");
  });

  it("handles mixed case and numbers", () => {
    expect(labelToFieldName("Address Line 1")).toBe("address_line_1");
  });
});

describe("ensureUniqueFieldName", () => {
  it("returns original name if not in existing names", () => {
    expect(ensureUniqueFieldName("email", ["name", "age"])).toBe("email");
  });

  it("appends _1 if name exists", () => {
    expect(ensureUniqueFieldName("email", ["email", "name"])).toBe("email_1");
  });

  it("increments counter until unique", () => {
    expect(ensureUniqueFieldName("field", ["field", "field_1", "field_2"])).toBe("field_3");
  });

  it("handles empty existing names", () => {
    expect(ensureUniqueFieldName("name", [])).toBe("name");
  });
});
