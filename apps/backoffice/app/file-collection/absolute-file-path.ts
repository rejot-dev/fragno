import { z } from "zod";

/** Virtual file paths are data, not URLs; reject traversal before reaching a collection. */
export const absoluteFilePathSchema = z
  .string()
  .regex(
    /^\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[^/\\\p{Cc}]+(?:\/[^/\\\p{Cc}]+)+$/u,
    "Use an absolute file path without empty or traversal segments.",
  );
