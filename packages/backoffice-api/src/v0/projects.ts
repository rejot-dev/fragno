import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { directoryPageInputSchema } from "./shared/pagination";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const projectSlugSchema = z.lazy(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Project slug must use lowercase letters, numbers, and single hyphens.",
    ),
);

export const projectCreateInputSchema = z
  .lazy(() =>
    z.strictObject({
      name: z.string().trim().min(1).max(160),
      slug: projectSlugSchema.nullable().default(null),
      description: z.string().trim().max(1000).nullable().default(null),
    }),
  )
  .meta({ id: "ProjectCreateInput" });
export type ProjectCreateInput = z.output<typeof projectCreateInputSchema>;

const projectCreateResultSchema = z
  .lazy(() =>
    z.strictObject({
      projectId: z.string().min(1),
      slug: projectSlugSchema,
    }),
  )
  .meta({ id: "ProjectCreateResult" });
export type ProjectCreateResult = z.output<typeof projectCreateResultSchema>;

const projectRecordSchema = z
  .lazy(() =>
    z.strictObject({
      projectId: z.string().min(1),
      slug: projectSlugSchema,
      name: z.string(),
      description: z.string().nullable(),
      archivedAt: z.iso.datetime().nullable(),
      createdByUserId: z.string().min(1),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }),
  )
  .meta({ id: "ProjectRecord" });

export const projectPageSchema = z
  .lazy(() =>
    z.strictObject({
      projects: z.array(projectRecordSchema),
      nextCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  )
  .meta({ id: "ProjectPage" });
export type ProjectPage = z.output<typeof projectPageSchema>;

export const projectsOperations = {
  "projects.list": {
    description:
      "List projects in the selected organization or personal scope, ordered by slug, including archived projects. Select the owner scope, not a project, app workspace, or System. Resume with nextCursor and the same pageSize.",
    permissions: [BACKOFFICE_PERMISSION.projects.read],
    input: directoryPageInputSchema,
    output: projectPageSchema,
  },
  "projects.create": {
    description:
      "Create a project in the selected organization or personal scope as the current user. Select the owner scope, not a project, app workspace, or System. Omit slug to derive it from the name; slugs must be unique within the owner.",
    permissions: [BACKOFFICE_PERMISSION.projects.create],
    input: projectCreateInputSchema,
    output: projectCreateResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
