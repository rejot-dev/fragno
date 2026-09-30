import type { ErrorObject } from "ajv";

import type { Translator, UISchemaElement } from "@jsonforms/core";

function numberParameter(error: ErrorObject, name: string) {
  const value = error.params[name];
  return typeof value === "number" ? value : null;
}

/** Converts JSON Schema implementation details into instructions a form respondent can act on. */
export function translateBackofficeJsonFormError(
  error: ErrorObject,
  _translate: Translator,
  _uischema?: UISchemaElement,
): string {
  switch (error.keyword) {
    case "required":
      return "This field is required.";
    case "format": {
      const format = error.params.format;
      if (format === "email") {
        return "Enter a valid email address.";
      }
      if (format === "date") {
        return "Enter a valid date.";
      }
      if (format === "time") {
        return "Enter a valid time.";
      }
      if (format === "date-time") {
        return "Enter a valid date and time.";
      }
      return "Enter a value in the expected format.";
    }
    case "type": {
      const expectedType = error.params.type;
      if (expectedType === "string") {
        return "Enter text for this field.";
      }
      if (expectedType === "number" || expectedType === "integer") {
        return "Enter a valid number.";
      }
      if (expectedType === "boolean") {
        return "Choose whether this option applies.";
      }
      return "Enter a valid value.";
    }
    case "minLength": {
      const limit = numberParameter(error, "limit");
      return limit === null
        ? "Enter a longer value."
        : `Enter at least ${limit} character${limit === 1 ? "" : "s"}.`;
    }
    case "maxLength": {
      const limit = numberParameter(error, "limit");
      return limit === null
        ? "Enter a shorter value."
        : `Enter no more than ${limit} character${limit === 1 ? "" : "s"}.`;
    }
    case "minimum": {
      const limit = numberParameter(error, "limit");
      return limit === null ? "Enter a larger number." : `Enter ${limit} or more.`;
    }
    case "maximum": {
      const limit = numberParameter(error, "limit");
      return limit === null ? "Enter a smaller number." : `Enter ${limit} or less.`;
    }
    case "exclusiveMinimum": {
      const limit = numberParameter(error, "limit");
      return limit === null ? "Enter a larger number." : `Enter a number greater than ${limit}.`;
    }
    case "exclusiveMaximum": {
      const limit = numberParameter(error, "limit");
      return limit === null ? "Enter a smaller number." : `Enter a number less than ${limit}.`;
    }
    case "enum":
      return "Choose one of the available options.";
    case "const":
      return "Choose the required value.";
    case "pattern":
      return "Enter a value in the requested format.";
    case "false schema":
      return "This value is not allowed.";
    case "additionalProperties":
      return "Remove fields that are not part of this form.";
    case "anyOf":
    case "oneOf":
      return "Choose a valid option.";
    default:
      return "Check this value and try again.";
  }
}

function passthroughTranslator(_id: string, defaultMessage: string, _values?: unknown): string;
function passthroughTranslator(
  _id: string,
  defaultMessage: undefined,
  _values?: unknown,
): undefined;
function passthroughTranslator(
  _id: string,
  defaultMessage?: string,
  _values?: unknown,
): string | undefined;
function passthroughTranslator(_id: string, defaultMessage?: string) {
  return defaultMessage;
}

export function getBackofficeJsonFormErrorMessages(
  errors: readonly ErrorObject[] | null | undefined,
) {
  return (errors ?? []).map((error) =>
    translateBackofficeJsonFormError(error, passthroughTranslator),
  );
}
