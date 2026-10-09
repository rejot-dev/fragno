import { automationStoreVerificationSchema } from "@fragno-dev/backoffice-api/v0/store";
import { z } from "zod";

import { Validator, type Schema } from "@cfworker/json-schema";

export const AUTOMATION_STORE_ROUTE_PATHS = {
  set: "/store/set",
  delete: "/store/delete",
} as const;

type AutomationStoreVerification = z.infer<typeof automationStoreVerificationSchema>[number];

export class AutomationStoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStoreVerificationError";
  }
}
const asValidatorSchema = (schema: unknown): Schema | boolean => {
  if (typeof schema === "boolean") {
    return schema;
  }
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Schema;
  }
  throw new AutomationStoreVerificationError(
    "json-schema verification requires schema to be an object or boolean.",
  );
};

const formatSchemaErrors = (errors: Array<{ instanceLocation: string; error: string }>) =>
  errors.map((error) => `${error.instanceLocation}: ${error.error}`).join(", ");

export const validateAutomationStoreVerification = ({
  value,
  verification,
}: {
  value: string;
  verification?: readonly AutomationStoreVerification[];
}) => {
  if (!verification?.length) {
    return;
  }

  for (const item of verification) {
    if (item.type !== "json-schema") {
      continue;
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch (cause) {
      throw new AutomationStoreVerificationError(
        `Store value must be valid JSON for json-schema verification: ${cause instanceof Error ? cause.message : "invalid JSON"}`,
      );
    }

    let validator: Validator;
    try {
      validator = new Validator(asValidatorSchema(item.schema), "2020-12", false);
    } catch (cause) {
      throw new AutomationStoreVerificationError(
        `Invalid store json-schema verification schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const result = validator.validate(parsedValue);
    if (!result.valid) {
      throw new AutomationStoreVerificationError(
        `Store value failed json-schema verification: ${formatSchemaErrors(result.errors)}`,
      );
    }
  }
};
