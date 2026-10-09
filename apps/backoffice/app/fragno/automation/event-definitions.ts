import type {
  AutomationEventDefinition,
  AutomationEventDefinitionCreateInput,
} from "@fragno-dev/backoffice-api/v0/events";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

import { Validator, type Schema } from "@cfworker/json-schema";

import { jsonSchema202012ValidationSchema } from "@/lib/json-schema/validation";

export const buildAutomationEventDefinitionId = (source: string, eventType: string) =>
  `${encodeURIComponent(source)}:${encodeURIComponent(eventType)}`;

export class AutomationEventDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationEventDefinitionValidationError";
  }
}

const formatSchemaErrors = (errors: Array<{ instanceLocation: string; error: string }>) =>
  errors.map((error) => `${error.instanceLocation}: ${error.error}`).join(", ");

export const assertAutomationEventJsonSchema = (schema: unknown, label: string) => {
  if (schema === null || typeof schema === "undefined") {
    return;
  }

  try {
    const validatorSchema = jsonSchema202012ValidationSchema.parse(schema) as Schema;
    new Validator(validatorSchema, "2020-12", false);
  } catch (cause) {
    throw new AutomationEventDefinitionValidationError(
      `Invalid ${label} JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

export const validateAutomationEventPayload = ({
  event,
  definition,
}: {
  event: Pick<AutomationEvent, "source" | "eventType" | "payload">;
  definition: Pick<AutomationEventDefinition, "enabled" | "payloadSchema"> | null | undefined;
}) => {
  if (!definition?.enabled || !definition.payloadSchema) {
    return;
  }

  let validator: Validator;
  try {
    validator = new Validator(definition.payloadSchema as Schema, "2020-12", false);
  } catch (cause) {
    throw new AutomationEventDefinitionValidationError(
      `Invalid automation event payload schema for ${event.source}/${event.eventType}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const result = validator.validate(event.payload);
  if (!result.valid) {
    throw new AutomationEventDefinitionValidationError(
      `Automation event ${event.source}/${event.eventType} payload failed schema validation: ${formatSchemaErrors(result.errors)}`,
    );
  }
};

export const assertAutomationEventDefinitionSchemas = (
  definition: Pick<
    AutomationEventDefinitionCreateInput,
    "payloadSchema" | "actorSchema" | "subjectSchema" | "example"
  >,
) => {
  assertAutomationEventJsonSchema(definition.payloadSchema, "payload");
  assertAutomationEventJsonSchema(definition.actorSchema, "actor");
  assertAutomationEventJsonSchema(definition.subjectSchema, "subject");

  if (
    definition.payloadSchema &&
    typeof definition.example !== "undefined" &&
    definition.example !== null
  ) {
    validateAutomationEventPayload({
      event: {
        source: "example",
        eventType: "example",
        payload: definition.example as Record<string, unknown>,
      },
      definition: { enabled: true, payloadSchema: definition.payloadSchema },
    });
  }
};
