import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

const formStatusInputValues = ["draft", "open", "closed"] as const;

const formSubmissionOutputSchema = z.object({
  id: z.string(),
  formId: z.string().nullable(),
  formVersion: z.number(),
  data: z.record(z.string(), z.unknown()),
  submittedAt: isoDateTimeOutputSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export const createFormInputSchema = z.object({
  title: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(formStatusInputValues).default("draft"),
  dataSchema: z.record(z.string(), z.unknown()),
  uiSchema: z.record(z.string(), z.unknown()).optional(),
});

export const formOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  slug: z.string(),
  status: z.enum(["draft", "open", "closed", "static"]),
  dataSchema: z.record(z.string(), z.unknown()),
  uiSchema: z.record(z.string(), z.unknown()).nullable(),
  version: z.number(),
  createdAt: isoDateTimeOutputSchema,
  updatedAt: isoDateTimeOutputSchema,
});

export const listFormSubmissionsInputSchema = z.object({
  formId: z.string().trim().min(1),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().nullable().default(null),
});

export const listFormSubmissionsOutputSchema = z.object({
  submissions: z.array(formSubmissionOutputSchema),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

export const updateFormInputSchema = createFormInputSchema.partial().extend({
  formId: z.string().trim().min(1),
  status: z.enum(formStatusInputValues).optional(),
});

export const formsOperations = {
  "forms.list": {
    description: "List forms stored in the global system Forms integration.",
    permissions: [BACKOFFICE_PERMISSION.forms.read],
    input: z.void(),
    output: z.object({ forms: z.array(formOutputSchema) }),
  },
  "forms.submissions.list": {
    description: "List responses submitted to a system form.",
    permissions: [BACKOFFICE_PERMISSION.forms.read],
    input: listFormSubmissionsInputSchema,
    output: listFormSubmissionsOutputSchema,
  },
  "forms.update": {
    description: "Update a schema-backed form in the global system Forms integration.",
    permissions: [BACKOFFICE_PERMISSION.forms.update],
    input: updateFormInputSchema,
    output: z.object({ updated: z.literal(true) }),
  },
  "forms.create": {
    description: "Create a schema-backed form in the global system Forms integration.",
    permissions: [BACKOFFICE_PERMISSION.forms.create],
    input: createFormInputSchema,
    output: z.object({ id: z.string() }),
  },
} satisfies Record<string, BackofficeApiOperation>;
