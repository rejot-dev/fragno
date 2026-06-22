import { z } from "zod";

export const projectSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Project slug must use lowercase letters, numbers, and single hyphens.",
  );

const projectDateSchema = z.preprocess((value) => {
  if (value instanceof Date && Number.isNaN(value.getTime())) {
    return new Date();
  }
  return value;
}, z.coerce.date());

export const automationProjectSchema = z.object({
  id: z.unknown(),
  slug: projectSlugSchema,
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  archivedAt: projectDateSchema.nullable(),
  createdByUserId: z.string().trim().min(1),
  createdAt: projectDateSchema,
  updatedAt: projectDateSchema,
});

export const automationProjectCreateInputSchema = z.object({
  slug: projectSlugSchema.optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  createdByUserId: z.string().trim().min(1),
});

export const automationProjectUpdateInputSchema = z.object({
  projectId: z.string().trim().min(1),
  slug: projectSlugSchema.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

export const automationProjectListInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export const automationProjectLookupInputSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    slug: projectSlugSchema.optional(),
  })
  .refine((value) => Boolean(value.projectId || value.slug), {
    message: "Either projectId or slug is required.",
  });

export const automationProjectArchiveInputSchema = z.object({
  projectId: z.string().trim().min(1),
});

export type AutomationProjectExecutionTarget = {
  projectId: string;
  slug: string;
  name: string;
};

export type AutomationProject = z.infer<typeof automationProjectSchema>;
export type AutomationProjectCreateInput = z.infer<typeof automationProjectCreateInputSchema>;
export type AutomationProjectUpdateInput = z.infer<typeof automationProjectUpdateInputSchema>;
export type AutomationProjectListInput = z.infer<typeof automationProjectListInputSchema>;
export type AutomationProjectLookupInput = z.infer<typeof automationProjectLookupInputSchema>;
export type AutomationProjectArchiveInput = z.infer<typeof automationProjectArchiveInputSchema>;

export const slugFromProjectName = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "project";
};
