import { z } from "zod";

export const codeDefinition = {
  props: z.strictObject({
    code: z.string().max(20_000),
    label: z.string().min(1).max(80).optional(),
    language: z.string().min(1).max(32).optional(),
  }),
  slots: [],
  description: "Displays bounded source or diagnostic text in a read-only code block.",
  example: { code: 'const status = "ready";', label: "Handler", language: "typescript" },
};
