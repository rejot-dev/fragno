import { z } from "zod";

// JSON Schema type (using record for flexibility - actual JSON Schema is complex)
export const dataSchemaZod = z.record(z.string(), z.unknown());

// UI Schema element types (using record for flexibility)
export const uiSchemaZod = z.record(z.string(), z.unknown());

// Form input/output schemas
export const createFormSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  slug: z.string().min(1),
  dataSchema: dataSchemaZod,
  uiSchema: uiSchemaZod,
});

export const FormStatusSchema = z.enum(["draft", "open", "closed"]);

export const FormSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  status: FormStatusSchema,
  dataSchema: JSONSchemaSchema,
  uiSchema: JSONSchemaSchema,
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const NewFormSchema = FormSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  version: true,
});

export const UpdateFormSchema = NewFormSchema.partial();

export const ResponseSchema = z.object({
  id: z.string(),
  formId: z.string(),
  formVersion: z.number(),
  data: z.record(z.string(), z.unknown()),
  submittedAt: z.date(),
});

export const NewResponseSchema = ResponseSchema.omit({
  id: true,
  submittedAt: true,
  formId: true,
  formVersion: true,
});

export type NewForm = z.infer<typeof NewFormSchema>;
export type UpdateForm = z.infer<typeof UpdateFormSchema>;
export type Form = z.infer<typeof FormSchema>;
export type NewResponse = z.infer<typeof NewResponseSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type FormStatus = z.infer<typeof FormStatusSchema>;
export type JSONSchema = z.infer<typeof JSONSchemaSchema>;
