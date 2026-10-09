import { z } from "zod";

/** Accepts a `Date` from Backoffice internals and always describes and returns an ISO string. */
export const isoDateTimeOutputSchema = z.preprocess((value) => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}, z.iso.datetime());

export const nullableIsoDateTimeOutputSchema = isoDateTimeOutputSchema.nullable();

/** For timestamps stored as free-form strings: a `Date` becomes ISO, a string passes through. */
export const dateTimeStringOutputSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string(),
);
