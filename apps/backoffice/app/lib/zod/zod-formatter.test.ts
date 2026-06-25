import { describe, expect, test } from "vitest";

import { z } from "zod";

import {
  formatJsonSchemaFields,
  jsonSchemaToTypeScriptRender,
  zodSchemaToJsonSchema,
  zodSchemaToTypeScript,
  zodSchemaToTypeScriptRender,
} from "./zod-formatter";

describe("zodSchemaToJsonSchema", () => {
  test("converts zod object schemas and removes zod metadata", () => {
    expect(
      zodSchemaToJsonSchema(
        z.object({
          id: z.string().min(1),
          count: z.number().int(),
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "count": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer",
          },
          "id": {
            "minLength": 1,
            "type": "string",
          },
        },
        "required": [
          "id",
          "count",
        ],
        "type": "object",
      }
    `);
  });

  test("represents dates as date-time strings", () => {
    expect(zodSchemaToJsonSchema(z.object({ occurredAt: z.date() }))).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "occurredAt": {
            "format": "date-time",
            "type": "string",
          },
        },
        "required": [
          "occurredAt",
        ],
        "type": "object",
      }
    `);
  });

  test("returns undefined for missing schemas", () => {
    expect(zodSchemaToJsonSchema(undefined)).toBeUndefined();
  });
});

describe("zodSchemaToTypeScript", () => {
  test("converts object schemas to TypeScript shapes", () => {
    expect(
      zodSchemaToTypeScript(
        z.object({
          id: z.string(),
          count: z.number().optional(),
          metadata: z.record(z.string(), z.unknown()),
        }),
        "output",
      ),
    ).toMatchInlineSnapshot(`
      "{
        id: string;
        count?: number;
        metadata: {
            [key: string]: unknown;
          };
      }"
    `);
  });

  test("converts unions, literals, enums, and arrays", () => {
    expect(
      zodSchemaToTypeScript(
        z.object({
          kind: z.literal("message"),
          status: z.enum(["pending", "sent"]),
          tags: z.array(z.string()),
          maybeText: z.string().nullable(),
        }),
        "output",
      ),
    ).toMatchInlineSnapshot(`
      "{
        kind: "message";
        status: "pending" | "sent";
        tags: string[];
        maybeText: string | null;
      }"
    `);
  });

  test("renders descriptions and date-time jsdoc", () => {
    expect(
      zodSchemaToTypeScript(
        z.object({
          described: z.string().describe("A documented field."),
          occurredAt: z.date(),
        }),
        "output",
      ),
    ).toMatchInlineSnapshot(`
      "{
        /** A documented field. */
        described: string;
        /** ISO 8601 datetime string. */
        occurredAt: string;
      }"
    `);
  });

  test("resolves named recursive refs from zod metadata", () => {
    type RecursiveFormatterNode =
      | { value: string }
      | { all: RecursiveFormatterNode[] }
      | { not: RecursiveFormatterNode };
    const nodeSchema: z.ZodType<RecursiveFormatterNode> = z
      .lazy(() =>
        z.union([
          z.object({ value: z.string() }),
          z.object({ all: z.array(nodeSchema) }),
          z.object({ not: nodeSchema }),
        ]),
      )
      .meta({ id: "RecursiveFormatterNode" });

    try {
      expect(
        zodSchemaToTypeScriptRender(z.object({ node: nodeSchema.nullable() }), "output", {
          rootTypeName: "RecursiveFormatterInput",
        }),
      ).toMatchInlineSnapshot(`
        {
          "declarations": [
            "type RecursiveFormatterNode = {
          value: string;
        } | {
          all: RecursiveFormatterNode[];
        } | {
          not: RecursiveFormatterNode;
        };",
          ],
          "type": "{
          node: RecursiveFormatterNode | null;
        }",
        }
      `);
    } finally {
      z.globalRegistry.remove(nodeSchema);
    }
  });

  test("gives generated recursive defs stable root-scoped names", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          type: "object",
          properties: {
            child: { $ref: "#/$defs/__schema0" },
          },
          required: ["child"],
          $defs: {
            __schema0: {
              anyOf: [
                { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                {
                  type: "object",
                  properties: { children: { type: "array", items: { $ref: "#/$defs/__schema0" } } },
                  required: ["children"],
                },
              ],
            },
          },
        },
        { rootTypeName: "GeneratedRefInput" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [
          "type GeneratedRefInputSchema0 = {
        value: string;
      } | {
        children: GeneratedRefInputSchema0[];
      };",
        ],
        "type": "{
        child: GeneratedRefInputSchema0;
      }",
      }
    `);
  });

  test("renders local definition refs and discovers nested declaration refs", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          type: "object",
          properties: {
            primary: { $ref: "#/$defs/Primary" },
          },
          required: ["primary"],
          $defs: {
            Primary: {
              type: "object",
              properties: {
                secondary: { $ref: "#/$defs/Secondary" },
              },
              required: ["secondary"],
            },
            Secondary: {
              type: "object",
              properties: {
                label: { type: "string" },
              },
              required: ["label"],
            },
          },
        },
        { rootTypeName: "NestedRefInput" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [
          "type Primary = {
        secondary: Secondary;
      };",
          "type Secondary = {
        label: string;
      };",
        ],
        "type": "{
        primary: Primary;
      }",
      }
    `);
  });

  test("supports legacy definitions refs", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          type: "object",
          properties: {
            address: { $ref: "#/definitions/address-model" },
          },
          required: ["address"],
          definitions: {
            "address-model": {
              id: "AddressModel",
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        },
        { rootTypeName: "LegacyDefinitionInput" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [
          "type AddressModel = {
        city: string;
      };",
        ],
        "type": "{
        address: AddressModel;
      }",
      }
    `);
  });

  test("keeps unresolved or external refs unknown", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          type: "object",
          properties: {
            external: { $ref: "https://example.com/schemas/External" },
            missing: { $ref: "#/$defs/Missing" },
            inlineObjectProperty: { $ref: "#/properties/external" },
          },
          required: ["external", "missing", "inlineObjectProperty"],
        },
        { rootTypeName: "UnknownRefsInput" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [],
        "type": "{
        external: unknown;
        missing: unknown;
        inlineObjectProperty: unknown;
      }",
      }
    `);
  });

  test("uses root type name for self refs", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          type: "object",
          properties: {
            parent: { anyOf: [{ $ref: "#" }, { type: "null" }] },
            value: { type: "string" },
          },
          required: ["parent", "value"],
        },
        { rootTypeName: "SelfRefNode" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [],
        "type": "{
        parent: SelfRefNode | null;
        value: string;
      }",
      }
    `);
  });

  test("sanitizes definition names and avoids collisions with the root type name", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          type: "object",
          properties: {
            rootLike: { $ref: "#/$defs/RouteInput" },
            dashed: { $ref: "#/$defs/dashed-name" },
            reserved: { $ref: "#/$defs/string" },
          },
          required: ["rootLike", "dashed", "reserved"],
          $defs: {
            RouteInput: { type: "string" },
            "dashed-name": { type: "number" },
            string: { type: "boolean" },
          },
        },
        { rootTypeName: "RouteInput" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [
          "type RouteInput2 = string;",
          "type DashedName = number;",
          "type Schemastring = boolean;",
        ],
        "type": "{
        rootLike: RouteInput2;
        dashed: DashedName;
        reserved: Schemastring;
      }",
      }
    `);
  });

  test("uses schema ids as root aliases when they differ from generated tool type names", () => {
    expect(
      jsonSchemaToTypeScriptRender(
        {
          id: "ReusableRoute",
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        { rootTypeName: "RouterCreateOutput" },
      ),
    ).toMatchInlineSnapshot(`
      {
        "declarations": [
          "type ReusableRoute = {
        id: string;
      };",
        ],
        "type": "ReusableRoute",
      }
    `);
  });

  test("uses codemodeInputId metadata for input-only declaration names", () => {
    const actionSchema = z
      .object({
        kind: z.literal("example"),
        defaulted: z.string().default("default"),
      })
      .meta({ id: "ExampleAction", codemodeInputId: "ExampleActionInput" });
    const routeSchema = z.object({ action: actionSchema });

    try {
      expect(
        zodSchemaToTypeScriptRender(routeSchema, "input", { rootTypeName: "ExampleRouteInput" }),
      ).toMatchInlineSnapshot(`
        {
          "declarations": [
            "type ExampleActionInput = {
          kind: "example";
          defaulted?: string;
        };",
          ],
          "type": "{
          action: ExampleActionInput;
        }",
        }
      `);
      expect(
        zodSchemaToTypeScriptRender(routeSchema, "output", { rootTypeName: "ExampleRouteOutput" }),
      ).toMatchInlineSnapshot(`
        {
          "declarations": [
            "type ExampleAction = {
          kind: "example";
          defaulted: string;
        };",
          ],
          "type": "{
          action: ExampleAction;
        }",
        }
      `);
    } finally {
      z.globalRegistry.remove(actionSchema);
    }
  });
});

describe("formatJsonSchemaFields", () => {
  test("formats fields from zod object schemas", () => {
    const schema = zodSchemaToJsonSchema(
      z.object({
        messageId: z.string().min(1),
        chatId: z.string().min(1),
        fromUserId: z.string().min(1).nullable(),
        text: z.string().nullable(),
        attachments: z.array(z.unknown()).optional(),
      }),
    );

    expect(formatJsonSchemaFields(schema)).toMatchInlineSnapshot(`
      "  messageId    string         required
        chatId       string         required
        fromUserId   string | null  required nullable
        text         string | null  required nullable
        attachments  array"
    `);
  });

  test("formats optional fields without notes or trailing padding", () => {
    const schema = zodSchemaToJsonSchema(
      z.object({
        nickname: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    );

    expect(formatJsonSchemaFields(schema)).toMatchInlineSnapshot(`
      "  nickname  string
        tags      string[]"
    `);
  });

  test("formats consts, enums, arrays, and nested objects", () => {
    const schema = zodSchemaToJsonSchema(
      z.object({
        kind: z.literal("external"),
        status: z.enum(["pending", "complete"]),
        children: z.array(z.object({ id: z.string() })),
        metadata: z.record(z.string(), z.unknown()),
      }),
    );

    expect(formatJsonSchemaFields(schema)).toMatchInlineSnapshot(`
      "  kind      "external"              required
        status    "pending" | "complete"  required
        children  object[]                required
        metadata  object                  required"
    `);
  });

  test("formats nullish schemas as empty", () => {
    expect(formatJsonSchemaFields(undefined)).toMatchInlineSnapshot(`"  -"`);
    expect(formatJsonSchemaFields({})).toMatchInlineSnapshot(`"  -"`);
  });
});
