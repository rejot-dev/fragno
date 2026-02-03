import { describe, it, expect } from "vitest";
import { parseSchemas } from "./schema-parser";
import { generateSchemas } from "./schema-generator";
import type { GeneratedSchemas, FormBuilderState } from "./types";

describe("parseSchemas", () => {
  it("parses text field", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/name" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]).toMatchObject({
      fieldName: "name",
      label: "Name",
      fieldType: "text",
      required: false,
    });
  });

  it("parses textarea via multi option", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          bio: { type: "string", title: "Bio" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/bio", options: { multi: true } }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("textarea");
  });

  it("parses slider via slider option", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          rating: { type: "number", title: "Rating", minimum: 1, maximum: 10 },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/rating", options: { slider: true } }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("slider");
    expect(result.fields[0].options?.minimum).toBe(1);
    expect(result.fields[0].options?.maximum).toBe(10);
  });

  it("parses select with enum values", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            title: "Status",
            enum: ["active", "inactive", "pending"],
          },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/status" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("select");
    expect(result.fields[0].options?.enumValues).toEqual(["active", "inactive", "pending"]);
  });

  it("parses number with min/max", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          age: { type: "number", title: "Age", minimum: 0, maximum: 150 },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/age" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("number");
    expect(result.fields[0].options?.minimum).toBe(0);
    expect(result.fields[0].options?.maximum).toBe(150);
  });

  it("parses integer type", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          count: { type: "integer", title: "Count" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/count" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("integer");
  });

  it("parses email format", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          email: { type: "string", title: "Email", format: "email" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/email" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("email");
  });

  it("parses date format", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          birthdate: { type: "string", title: "Birth Date", format: "date" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/birthdate" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("date");
  });

  it("parses time format", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          start_time: { type: "string", title: "Start Time", format: "time" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/start_time" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("time");
  });

  it("parses datetime format", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          created_at: { type: "string", title: "Created At", format: "date-time" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/created_at" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("datetime");
  });

  it("parses boolean type", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          newsletter: { type: "boolean", title: "Newsletter" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/newsletter" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("boolean");
  });

  it("preserves field order from UI schema", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          first: { type: "string", title: "First" },
          second: { type: "string", title: "Second" },
          third: { type: "string", title: "Third" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/third" },
          { type: "Control", scope: "#/properties/first" },
          { type: "Control", scope: "#/properties/second" },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields.map((f) => f.fieldName)).toEqual(["third", "first", "second"]);
  });

  it("includes label elements from UI schema", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          first: { type: "string", title: "First" },
          second: { type: "string", title: "Second" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/first" },
          { type: "Label", text: "Section label" },
          { type: "Control", scope: "#/properties/second" },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields.map((field) => field.fieldType)).toEqual(["text", "label", "text"]);
    expect(result.fields[1].label).toBe("Section label");
  });

  it("handles required fields", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          email: { type: "string", title: "Email", format: "email" },
          phone: { type: "string", title: "Phone" },
        },
        required: ["name", "email"],
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/name" },
          { type: "Control", scope: "#/properties/email" },
          { type: "Control", scope: "#/properties/phone" },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].required).toBe(true);
    expect(result.fields[1].required).toBe(true);
    expect(result.fields[2].required).toBe(false);
  });

  it("handles missing UI schema gracefully", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          email: { type: "string", title: "Email", format: "email" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields).toHaveLength(2);
    expect(result.fields.map((f) => f.fieldName)).toEqual(["name", "email"]);
  });

  it("handles description field", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", description: "Enter your full name" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/name" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].description).toBe("Enter your full name");
  });

  it("handles placeholder option", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/name", options: { placeholder: "John Doe" } },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].options?.placeholder).toBe("John Doe");
  });

  it("falls back to humanized fieldName when title is missing", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          user_email: { type: "string" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/user_email" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].label).toBe("User Email");
  });

  it("handles properties not in UI schema", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          visible: { type: "string", title: "Visible" },
          hidden: { type: "string", title: "Hidden" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/visible" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].fieldName).toBe("visible");
    expect(result.fields[1].fieldName).toBe("hidden");
  });

  it("marks array type as unsupported", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          tags: { type: "array", title: "Tags" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/tags" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("unsupported");
    expect(result.fields[0].options?.rawJsonSchema).toBeDefined();
    expect(JSON.parse(result.fields[0].options!.rawJsonSchema!)).toEqual({
      type: "array",
      title: "Tags",
    });
  });

  it("marks object type as unsupported", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          address: {
            type: "object",
            title: "Address",
            properties: { street: { type: "string" } },
          },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/address" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("unsupported");
    expect(result.fields[0].options?.rawJsonSchema).toBeDefined();
  });

  it("marks unknown string format as unsupported", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          custom: { type: "string", title: "Custom", format: "custom-format" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [{ type: "Control", scope: "#/properties/custom" }],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("unsupported");
    expect(result.fields[0].options?.rawJsonSchema).toContain("custom-format");
  });

  it("preserves UI schema for unsupported fields", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          items: { type: "array", title: "Items" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          {
            type: "Control",
            scope: "#/properties/items",
            options: { showSortButtons: true },
          },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].options?.rawUiSchema).toBeDefined();
    const uiSchema = JSON.parse(result.fields[0].options!.rawUiSchema!);
    expect(uiSchema.options?.showSortButtons).toBe(true);
  });

  it("handles nested HorizontalLayout within VerticalLayout", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          first_name: { type: "string", title: "First Name" },
          last_name: { type: "string", title: "Last Name" },
          email: { type: "string", title: "Email", format: "email" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          {
            type: "HorizontalLayout",
            elements: [
              { type: "Control", scope: "#/properties/first_name" },
              { type: "Control", scope: "#/properties/last_name" },
            ],
          },
          { type: "Control", scope: "#/properties/email" },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields).toHaveLength(3);
    expect(result.fields.map((f) => f.fieldName)).toEqual(["first_name", "last_name", "email"]);
  });

  it("handles deeply nested Group layouts", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          street: { type: "string", title: "Street" },
          city: { type: "string", title: "City" },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/name" },
          {
            type: "Group",
            elements: [
              {
                type: "VerticalLayout",
                elements: [
                  { type: "Control", scope: "#/properties/street" },
                  { type: "Control", scope: "#/properties/city" },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields).toHaveLength(3);
    expect(result.fields.map((f) => f.fieldName)).toEqual(["name", "street", "city"]);
  });

  it("extracts options from controls in nested layouts", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          bio: { type: "string", title: "Bio" },
          rating: { type: "number", title: "Rating", minimum: 1, maximum: 5 },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          {
            type: "HorizontalLayout",
            elements: [
              { type: "Control", scope: "#/properties/bio", options: { multi: true } },
              { type: "Control", scope: "#/properties/rating", options: { slider: true } },
            ],
          },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("textarea");
    expect(result.fields[1].fieldType).toBe("slider");
  });
});

describe("round-trip", () => {
  it("parseSchemas(generateSchemas(state)) preserves field data", () => {
    const originalState: FormBuilderState = {
      fields: [
        {
          id: "1",
          fieldName: "name",
          label: "Full Name",
          description: "Enter your full name",
          fieldType: "text",
          required: true,
          options: { placeholder: "John Doe" },
        },
        {
          id: "2",
          fieldName: "email",
          label: "Email Address",
          fieldType: "email",
          required: true,
        },
        {
          id: "3",
          fieldName: "rating",
          label: "Rating",
          fieldType: "slider",
          required: false,
          options: { minimum: 1, maximum: 10 },
        },
        {
          id: "4",
          fieldName: "status",
          label: "Status",
          fieldType: "select",
          required: false,
          options: { enumValues: ["active", "inactive"] },
        },
        {
          id: "5",
          fieldName: "subscribe",
          label: "Subscribe",
          fieldType: "boolean",
          required: false,
        },
        {
          id: "6",
          fieldName: "bio",
          label: "Biography",
          fieldType: "textarea",
          required: false,
        },
        {
          id: "7",
          fieldName: "birth_date",
          label: "Birth Date",
          fieldType: "date",
          required: false,
        },
      ],
    };

    const schemas = generateSchemas(originalState);
    const parsedState = parseSchemas(schemas);

    expect(parsedState.fields).toHaveLength(originalState.fields.length);

    for (let i = 0; i < originalState.fields.length; i++) {
      const original = originalState.fields[i];
      const parsed = parsedState.fields[i];

      expect(parsed.fieldName).toBe(original.fieldName);
      expect(parsed.label).toBe(original.label);
      expect(parsed.description).toBe(original.description);
      expect(parsed.fieldType).toBe(original.fieldType);
      expect(parsed.required).toBe(original.required);

      if (original.options) {
        expect(parsed.options?.enumValues).toEqual(original.options.enumValues);
        expect(parsed.options?.minimum).toBe(original.options.minimum);
        expect(parsed.options?.maximum).toBe(original.options.maximum);
        expect(parsed.options?.placeholder).toBe(original.options.placeholder);
      }
    }
  });

  it("preserves field order through round-trip", () => {
    const originalState: FormBuilderState = {
      fields: [
        { id: "1", fieldName: "third", label: "Third", fieldType: "text", required: false },
        { id: "2", fieldName: "first", label: "First", fieldType: "text", required: false },
        { id: "3", fieldName: "second", label: "Second", fieldType: "text", required: false },
      ],
    };

    const schemas = generateSchemas(originalState);
    const parsedState = parseSchemas(schemas);

    expect(parsedState.fields.map((f) => f.fieldName)).toEqual(["third", "first", "second"]);
  });

  it("handles number type with constraints", () => {
    const originalState: FormBuilderState = {
      fields: [
        {
          id: "1",
          fieldName: "age",
          label: "Age",
          fieldType: "number",
          required: false,
          options: { minimum: 0, maximum: 150 },
        },
      ],
    };

    const schemas = generateSchemas(originalState);
    const parsedState = parseSchemas(schemas);

    expect(parsedState.fields[0].fieldType).toBe("number");
    expect(parsedState.fields[0].options?.minimum).toBe(0);
    expect(parsedState.fields[0].options?.maximum).toBe(150);
  });

  it("preserves slider default value", () => {
    const schemas: GeneratedSchemas = {
      dataSchema: {
        type: "object",
        properties: {
          rating: { type: "number", title: "Rating", minimum: 1, maximum: 5, default: 3 },
        },
      },
      uiSchema: {
        type: "VerticalLayout",
        elements: [
          {
            type: "Control",
            scope: "#/properties/rating",
            options: { slider: true },
          },
        ],
      },
    };

    const result = parseSchemas(schemas);

    expect(result.fields[0].fieldType).toBe("slider");
    expect(result.fields[0].options?.defaultValue).toBe(3);
  });

  it("handles integer type with constraints", () => {
    const originalState: FormBuilderState = {
      fields: [
        {
          id: "1",
          fieldName: "count",
          label: "Count",
          fieldType: "integer",
          required: false,
          options: { minimum: 1, maximum: 100 },
        },
      ],
    };

    const schemas = generateSchemas(originalState);
    const parsedState = parseSchemas(schemas);

    expect(parsedState.fields[0].fieldType).toBe("integer");
    expect(parsedState.fields[0].options?.minimum).toBe(1);
    expect(parsedState.fields[0].options?.maximum).toBe(100);
  });

  it("handles datetime and time formats", () => {
    const originalState: FormBuilderState = {
      fields: [
        {
          id: "1",
          fieldName: "meeting_time",
          label: "Meeting Time",
          fieldType: "time",
          required: false,
        },
        {
          id: "2",
          fieldName: "appointment",
          label: "Appointment",
          fieldType: "datetime",
          required: false,
        },
      ],
    };

    const schemas = generateSchemas(originalState);
    const parsedState = parseSchemas(schemas);

    expect(parsedState.fields[0].fieldType).toBe("time");
    expect(parsedState.fields[1].fieldType).toBe("datetime");
  });

  it("round-trips unsupported field with raw schemas", () => {
    const rawJsonSchema = JSON.stringify({ type: "array", items: { type: "string" } }, null, 2);
    const rawUiSchema = JSON.stringify(
      { type: "Control", scope: "#/properties/tags", options: { showSortButtons: true } },
      null,
      2,
    );

    const originalState: FormBuilderState = {
      fields: [
        {
          id: "1",
          fieldName: "tags",
          label: "Tags",
          fieldType: "unsupported",
          required: false,
          options: { rawJsonSchema, rawUiSchema },
        },
      ],
    };

    const schemas = generateSchemas(originalState);

    expect(schemas.dataSchema.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(schemas.uiSchema.elements?.[0]).toEqual({
      type: "Control",
      scope: "#/properties/tags",
      options: { showSortButtons: true },
    });

    const parsedState = parseSchemas(schemas);
    expect(parsedState.fields[0].fieldType).toBe("unsupported");
    expect(parsedState.fields[0].options?.rawJsonSchema).toBeDefined();
  });
});
