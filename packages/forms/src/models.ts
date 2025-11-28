import { z } from "zod";

export const JSONSchemaSchema = z.record(z.string(), z.unknown());
export const UISchemaElementSchema = z.record(z.string(), z.unknown());

export const FormStatusSchema = z.enum(["draft", "open", "closed", "static"]);

export const FormSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  status: FormStatusSchema,
  dataSchema: JSONSchemaSchema,
  uiSchema: UISchemaElementSchema,
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

export const ResponseMetadataSchema = z.object({
  ip: z.union([z.ipv4(), z.ipv6()]).nullable(),
  userAgent: z.string().max(4096).nullable(),
});

export const ResponseSchema = z.object({
  id: z.string(),
  formId: z.string().nullable().describe("Form ID (static form ID or database form external ID)"),
  formVersion: z.number(),
  data: z.record(z.string(), z.unknown()),
  submittedAt: z.date(),
  ip: z.string().max(45).nullable(),
  userAgent: z.string().max(512).nullable(),
});

export const NewResponseSchema = ResponseSchema.omit({
  id: true,
  submittedAt: true,
  formId: true,
  formVersion: true,
  ip: true,
  userAgent: true,
}).extend({
  securityToken: z.string().optional(),
});

export type NewForm = z.infer<typeof NewFormSchema>;
export type UpdateForm = z.infer<typeof UpdateFormSchema>;
export type Form = z.infer<typeof FormSchema>;
export type NewResponse = z.infer<typeof NewResponseSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type ResponseMetadata = z.infer<typeof ResponseMetadataSchema>;
export type FormStatus = z.infer<typeof FormStatusSchema>;
export type JSONSchema = z.infer<typeof JSONSchemaSchema>;
export type UIElementSchema = z.infer<typeof UISchemaElementSchema>;
