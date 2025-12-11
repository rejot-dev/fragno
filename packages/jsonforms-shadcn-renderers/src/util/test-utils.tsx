import type { JsonFormsCore, JsonSchema, TesterContext, UISchemaElement } from "@jsonforms/core";
import { createAjv } from "@jsonforms/core";
import type { JsonFormsReactProps } from "@jsonforms/react";
import { useJsonForms } from "@jsonforms/react";
import { useEffect } from "react";

export const initCore = (
  schema: JsonSchema,
  uischema: UISchemaElement,
  data?: unknown,
): JsonFormsCore => {
  return { schema, uischema, data, ajv: createAjv() };
};

export const TestEmitter: React.FC<JsonFormsReactProps> = ({ onChange }) => {
  const ctx = useJsonForms();
  const data = ctx.core?.data;
  const errors = ctx.core?.errors;
  useEffect(() => {
    if (onChange) {
      onChange({ data, errors });
    }
  }, [data, errors, onChange]);
  return null;
};

export const createTesterContext = (rootSchema: JsonSchema, config?: unknown): TesterContext => {
  return { rootSchema, config };
};
