import { z } from "zod";

export const normalizeRuntimeOutput = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeRuntimeOutput);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [key, normalizeRuntimeOutput(childValue)]),
    );
  }

  return value;
};

export const isoDateTimeOutputSchema = z.preprocess((value) => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}, z.iso.datetime());

export const nullableIsoDateTimeOutputSchema = isoDateTimeOutputSchema.nullable();
