import type { TSchema as SinclairSchema } from "@sinclair/typebox";

type SinclairSymbols = typeof import("@sinclair/typebox");

const Kind = Symbol.for("TypeBox.Kind") as SinclairSymbols["Kind"];
const OptionalKind = Symbol.for("TypeBox.Optional") as SinclairSymbols["OptionalKind"];
const ReadonlyKind = Symbol.for("TypeBox.Readonly") as SinclairSymbols["ReadonlyKind"];
const Hint = Symbol.for("TypeBox.Hint") as SinclairSymbols["Hint"];

type TypeBoxV1Schema = {
  "~kind"?: string;
  "~optional"?: boolean;
  "~readonly"?: boolean;
  "~hint"?: unknown;
  params?: unknown[];
  static?: unknown;
};

export function withSinclairSchema<T extends TypeBoxV1Schema>(schema: T): T & SinclairSchema {
  const target = schema as Record<symbol, unknown> & {
    params?: unknown[];
    static?: unknown;
  };

  const kind = schema["~kind"];
  if (kind && target[Kind] === undefined) {
    target[Kind] = kind;
  }

  if (schema["~optional"] && target[OptionalKind] === undefined) {
    target[OptionalKind] = "Optional";
  }

  if (schema["~readonly"] && target[ReadonlyKind] === undefined) {
    target[ReadonlyKind] = "Readonly";
  }

  const hint = schema["~hint"];
  if (typeof hint === "string" && target[Hint] === undefined) {
    target[Hint] = hint;
  }

  const paramsValue = "params" in target ? target.params : [];
  Object.defineProperty(target, "params", {
    value: Array.isArray(paramsValue) ? paramsValue : [],
    writable: true,
    configurable: true,
    enumerable: false,
  });

  const staticValue = "static" in target ? target.static : undefined;
  Object.defineProperty(target, "static", {
    value: staticValue,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  return target as unknown as T & SinclairSchema;
}
