import { describe, expect, test } from "vitest";

import { z } from "zod";

import {
  formatJsonSchemaFields,
  zodSchemaToJsonSchema,
  zodSchemaToTypeScript,
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
