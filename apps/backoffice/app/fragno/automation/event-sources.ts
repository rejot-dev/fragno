import { z } from "zod";

export const automationEventSourceCategorySchema = z.enum([
  "app_activity",
  "backoffice_activity",
  "lifecycle",
  "custom",
]);

export const automationEventSourceSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string(),
  category: automationEventSourceCategorySchema,
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
});

export const automationEventSourceInputSchema = z.object({
  source: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string(),
  category: automationEventSourceCategorySchema,
});

export type AutomationEventSource = z.infer<typeof automationEventSourceSchema>;
export type AutomationEventSourceInput = z.input<typeof automationEventSourceInputSchema>;

/** Encodes user-defined source names so synchronized primary keys remain stable and URL-safe. */
export function buildAutomationEventSourceId(source: string): string {
  return encodeURIComponent(source);
}
