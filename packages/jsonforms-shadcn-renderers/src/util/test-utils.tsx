import { useEffect } from "react";

import type { JsonFormsCore, JsonSchema, TesterContext, UISchemaElement } from "@jsonforms/core";
import { createAjv } from "@jsonforms/core";
import type { JsonFormsReactProps } from "@jsonforms/react";
import { useJsonForms } from "@jsonforms/react";

export const initCore = (
  schema: JsonSchema,
  uischema: UISchemaElement,
  data?: unknown,
): JsonFormsCore => {
  return { schema, uischema, data, ajv: createAjv() };
};

export const TestEmitter: React.FC<JsonFormsReactProps> = (props) => {
  const ctx = useJsonForms();
  const data = ctx.core?.data;
  const errors = ctx.core?.errors;
  useEffect(() => {
    if (props.onChange) {
      props.onChange({ data, errors });
    }
  }, [
    data,
    errors,
    // oxlint-disable-next-line typescript/unbound-method -- JsonForms types onChange as a method even though React invokes it as a callback prop.
    props.onChange,
  ]);
  return null;
};

export const createTesterContext = (rootSchema: JsonSchema, config?: unknown): TesterContext => {
  return { rootSchema, config };
};
