import { projectPageSchema, projectSlugSchema } from "@fragno-dev/backoffice-api/v0/projects";
import { directoryPageInputSchema } from "@fragno-dev/backoffice-api/v0/shared/pagination";

import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor, isUniqueConstraintError, type Cursor } from "@fragno-dev/db";

import { automationFragmentDefinition } from "./definition";
import {
  automationProjectCreateInputSchema,
  automationProjectSchema,
  automationProjectUpdateInputSchema,
} from "./projects";
import { AutomationProjectOwnerRequiredError } from "./projects-storage-runtime";

export const automationProjectRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, services }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/projects",
        queryParameters: ["pageSize", "cursor"],
        outputSchema: projectPageSchema,
        handler: async function ({ query }, { json, error }) {
          const parsed = directoryPageInputSchema.safeParse({
            pageSize: query.has("pageSize") ? Number(query.get("pageSize")) : undefined,
            cursor: query.get("cursor"),
          });
          if (!parsed.success) {
            return error(
              {
                message: "Invalid project list input.",
                code: "PROJECT_LIST_INPUT_INVALID",
              },
              400,
            );
          }

          let cursor: Cursor | null = null;
          try {
            if (parsed.data.cursor !== null) {
              cursor = decodeCursor(parsed.data.cursor);
              if (
                cursor.indexName !== "idx_project_slug" ||
                cursor.orderDirection !== "asc" ||
                cursor.pageSize !== parsed.data.pageSize ||
                typeof cursor.indexValues.slug !== "string"
              ) {
                throw new Error("Cursor does not match the project listing.");
              }
            }
          } catch {
            return error(
              { message: "Invalid project list cursor.", code: "PROJECT_LIST_CURSOR_INVALID" },
              400,
            );
          }

          const page = await this.handlerTx()
            .withServiceCalls(
              () => [services.listProjects({ pageSize: parsed.data.pageSize, cursor })] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          return json({
            projects: page.items.map((project) => ({
              projectId: project.id.valueOf(),
              slug: project.slug,
              name: project.name,
              description: project.description,
              archivedAt: project.archivedAt?.toISOString() ?? null,
              createdByUserId: project.createdByUserId,
              createdAt: project.createdAt.toISOString(),
              updatedAt: project.updatedAt.toISOString(),
            })),
            nextCursor: page.hasNextPage && page.cursor ? page.cursor.encode() : null,
            hasNextPage: page.hasNextPage,
          });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/projects",
        inputSchema: automationProjectCreateInputSchema,
        outputSchema: automationProjectSchema,
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();
          try {
            const project = await this.handlerTx()
              .withServiceCalls(() => [services.createProject(payload)] as const)
              .transform(({ serviceResult: [result] }) => result)
              .execute();
            return json(project);
          } catch (cause) {
            if (isUniqueConstraintError(cause)) {
              return error(
                {
                  message: "Project slug is already used in this Automations object.",
                  code: "PROJECT_SLUG_CONFLICT",
                },
                409,
              );
            }
            if (cause instanceof AutomationProjectOwnerRequiredError) {
              return error({ message: cause.message, code: "PROJECT_OWNER_SCOPE_REQUIRED" }, 500);
            }
            throw cause;
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/projects/:projectId",
        outputSchema: automationProjectSchema,
        handler: async function ({ pathParams }, { json, error }) {
          const project = await this.handlerTx()
            .withServiceCalls(
              () => [services.getProject({ projectId: pathParams.projectId })] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!project) {
            return error(
              {
                message: "Project not found.",
                code: "PROJECT_NOT_FOUND",
              },
              404,
            );
          }

          return json(project);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/projects/by-slug/:slug",
        outputSchema: automationProjectSchema,
        handler: async function ({ pathParams }, { json, error }) {
          const slug = projectSlugSchema.safeParse(pathParams.slug);
          const project = slug.success
            ? await this.handlerTx()
                .withServiceCalls(() => [services.getProject({ slug: slug.data })] as const)
                .transform(({ serviceResult: [result] }) => result)
                .execute()
            : null;
          if (!project) {
            return error({ message: "Project not found.", code: "PROJECT_NOT_FOUND" }, 404);
          }

          return json(project);
        },
      }),
      defineRoute({
        method: "PATCH",
        path: "/projects/:projectId",
        inputSchema: automationProjectUpdateInputSchema.omit({ projectId: true }),
        outputSchema: automationProjectSchema,
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();
          try {
            const project = await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    services.updateProject({ ...payload, projectId: pathParams.projectId }),
                  ] as const,
              )
              .transform(({ serviceResult: [result] }) => result)
              .execute();
            if (!project) {
              return error({ message: "Project not found.", code: "PROJECT_NOT_FOUND" }, 404);
            }
            return json(project);
          } catch (cause) {
            if (isUniqueConstraintError(cause)) {
              return error(
                {
                  message: "Project slug is already used in this Automations object.",
                  code: "PROJECT_SLUG_CONFLICT",
                },
                409,
              );
            }
            throw cause;
          }
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/projects/:projectId",
        outputSchema: automationProjectSchema,
        handler: async function ({ pathParams }, { json, error }) {
          const project = await this.handlerTx()
            .withServiceCalls(
              () => [services.archiveProject({ projectId: pathParams.projectId })] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!project) {
            return error({ message: "Project not found.", code: "PROJECT_NOT_FOUND" }, 404);
          }
          return json(project);
        },
      }),
    ];
  },
);
