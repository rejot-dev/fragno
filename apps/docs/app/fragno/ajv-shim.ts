import { Validator, type Schema } from "@cfworker/json-schema";

type AjvError = {
  instancePath: string;
  keyword?: string;
  message?: string;
  params?: {
    missingProperty?: string;
  };
};

type ValidateFunction = ((data: unknown) => boolean) & {
  errors: AjvError[] | null;
};

type AjvOptions = {
  allErrors?: boolean;
  coerceTypes?: boolean;
  strict?: boolean;
  code?: {
    formats?: unknown;
  };
};

type SupportedDraft = "4" | "7" | "2019-09" | "2020-12";

function resolveDraft(schema: unknown): SupportedDraft {
  if (schema && typeof schema === "object") {
    const schemaValue = (schema as { $schema?: string }).$schema;
    if (schemaValue) {
      if (schemaValue.includes("draft-04")) {
        return "4";
      }
      if (schemaValue.includes("draft-07")) {
        return "7";
      }
      if (schemaValue.includes("2019-09")) {
        return "2019-09";
      }
      if (schemaValue.includes("2020-12")) {
        return "2020-12";
      }
    }
  }

  return "2020-12";
}

function normalizeInstancePath(instanceLocation: string | undefined): string {
  if (!instanceLocation || instanceLocation === "#") {
    return "";
  }

  if (instanceLocation.startsWith("#/")) {
    return instanceLocation.slice(1);
  }

  if (instanceLocation.startsWith("#")) {
    return "";
  }

  return instanceLocation;
}

function extractMissingProperty(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  const match = /"([^"]+)"/.exec(message);
  return match?.[1];
}

function toAjvError(error: { instanceLocation: string; keyword: string; error: string }): AjvError {
  const missingProperty =
    error.keyword === "required" ? extractMissingProperty(error.error) : undefined;

  return {
    instancePath: normalizeInstancePath(error.instanceLocation),
    keyword: error.keyword,
    message: error.error,
    params: missingProperty ? { missingProperty } : {},
  };
}

function asValidatorSchema(schema: unknown): Schema | boolean {
  if (typeof schema === "boolean") {
    return schema;
  }
  if (schema && typeof schema === "object") {
    return schema as Schema;
  }

  throw new TypeError("Schema must be an object or boolean.");
}

class AjvShim {
  opts: AjvOptions;
  private schemas: Array<{ schema: unknown; id?: string }> = [];
  private formats = new Map<string, unknown>();

  constructor(options: AjvOptions = {}) {
    this.opts = { ...options, code: options.code ?? {} };
  }

  addSchema(schema: unknown, id?: string) {
    this.schemas.push({ schema, id });
    return this;
  }

  addFormat(name: string, format: unknown) {
    this.formats.set(name, format);
    return this;
  }

  addKeyword() {
    return this;
  }

  compile(schema: unknown): ValidateFunction {
    const shortCircuit = !(this.opts.allErrors ?? false);
    const validator = new Validator(asValidatorSchema(schema), resolveDraft(schema), shortCircuit);

    for (const { schema: extraSchema, id } of this.schemas) {
      validator.addSchema(extraSchema as object, id);
    }

    const validate = ((data: unknown) => {
      const result = validator.validate(data);
      if (result.valid) {
        validate.errors = null;
        return true;
      }
      validate.errors = result.errors.map(toAjvError);
      return false;
    }) as ValidateFunction;

    validate.errors = null;
    return validate;
  }

  validate(schema: unknown, data: unknown): boolean {
    const validate = this.compile(schema);
    return validate(data);
  }

  errorsText(errors: AjvError[] | null | undefined) {
    if (!errors || errors.length === 0) {
      return "";
    }
    return errors.map((err) => err.message ?? "validation error").join(", ");
  }
}

export default AjvShim;
