import { z } from "zod";

import { preparedUploadedFileReferenceSchema } from "@/fragno/prepared-upload";

import { generatedUiUploadScopeSchema } from "../generated-ui-upload-scope";

const acceptedFileTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      /^\.[a-z0-9][a-z0-9.+_-]*$/i.test(value) ||
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i.test(value),
    "Use a file extension such as .pdf or a MIME type such as image/png.",
  );

export const fileUploadDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    scope: generatedUiUploadScopeSchema,
    value: preparedUploadedFileReferenceSchema.nullable(),
    description: z.string().max(500).optional(),
    accept: z.array(acceptedFileTypeSchema).min(1).max(20).optional(),
    maxSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
  slots: [],
  description:
    "Uploads one private file as a prepared Upload draft. Use the current workflow context or a declared org, project, or personal scope. Bind value with {$bindState: '/path'}; state receives one serializable prepared-upload reference.",
  example: {
    label: "Supporting document",
    scope: { kind: "current" },
    value: { $bindState: "/response/attachment" },
    accept: [".pdf", "image/png", "image/jpeg"],
    maxSizeBytes: 26_214_400,
    required: true,
  },
};
