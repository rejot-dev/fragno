import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { loadAutomationCatalogFromConfig } from "./catalog";
import { automationFragmentDefinition } from "./definition";
import {
  automationProjectCreateInputSchema,
  automationProjectListInputSchema,
  automationProjectSchema,
  automationProjectUpdateInputSchema,
} from "./projects";

export const automationProjectRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, config, services }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/scripts",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function ({ query }, { json, error }) {
          try {
            const orgId = query.get("orgId")?.trim() || undefined;
            const catalog = await loadAutomationCatalogFromConfig(config, {
              execution: {
                actor: { type: "system", id: "system" },
                scope: orgId ? { kind: "org", orgId } : { kind: "system" },
              },
              purpose: "route",
            });
            return json(catalog.scripts);
          } catch (cause) {
            return error(
              {
                message:
                  cause instanceof Error ? cause.message : "Failed to load automation scripts.",
                code: "AUTOMATION_CATALOG_INVALID",
              },
              500,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/projects",
        outputSchema: z.array(automationProjectSchema),
        handler: async function ({ query }, { json, error }) {
          const limitRaw = query.get("limit")?.trim();
          const limit = limitRaw ? Number(limitRaw) : undefined;
          const parsed = automationProjectListInputSchema.safeParse({
            limit,
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

          const projects = await this.handlerTx()
            .withServiceCalls(() => [services.listProjects(parsed.data)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          return json(projects);
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
            if (
              cause instanceof Error &&
              cause.message === "Projects can only be created in org-scoped Automations."
            ) {
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
