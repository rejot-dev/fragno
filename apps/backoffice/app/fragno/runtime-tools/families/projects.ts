import { projectCreateInputSchema } from "@fragno-dev/backoffice-api/v0/projects";
import { directoryPageInputSchema } from "@fragno-dev/backoffice-api/v0/shared/pagination";
import type { z } from "zod";

import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { ProjectsRuntime } from "./projects-runtime";

type ProjectsToolContext = BackofficeToolContext<{ projects: ProjectsRuntime | undefined }>;

function getProjectsRuntime(context: ProjectsToolContext): ProjectsRuntime {
  if (!context.runtimes.projects) {
    throw new Error(
      "Project tools require an organization or personal scope and a user principal.",
    );
  }
  return context.runtimes.projects;
}

const listProjectsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("projects.list"),
  namespace: "projects",
  name: "list",
  async execute(input, context: ProjectsToolContext) {
    return await getProjectsRuntime(context).list(input);
  },
  adapters: {
    bash: {
      command: "projects.list",
      help: {
        summary: "List the selected owner's projects by slug, including archived projects.",
        options: [
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: "Page size, 1–100 (default 25).",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous page; keep the same page size.",
          },
        ],
        examples: [
          "projects.list",
          "projects.list --format json",
          "projects.list --page-size 10 --cursor CURSOR",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof directoryPageInputSchema>>("projects.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (page, options) =>
        options.format === "json" || options.print
          ? { data: page }
          : {
              data: page,
              stdout: [
                page.projects.length ? `Projects (${page.projects.length}):` : "No projects found.",
                ...page.projects.map(
                  (project) =>
                    `${project.slug}\t${project.name}\t${project.projectId}${project.archivedAt === null ? "" : "\tarchived"}`,
                ),
                `More results: ${page.hasNextPage ? "yes" : "no"}`,
                `Next cursor: ${page.nextCursor ?? "none"}`,
                "",
              ].join("\n"),
            },
    },
  },
});

const createProjectTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("projects.create"),
  namespace: "projects",
  name: "create",
  async execute(input, context: ProjectsToolContext) {
    return await getProjectsRuntime(context).create(input);
  },
  adapters: {
    bash: {
      command: "projects.create",
      help: {
        summary: "Create a project in the selected owner scope as the current user.",
        options: [
          {
            name: "name",
            required: true,
            valueRequired: true,
            description: "Project name.",
          },
          {
            name: "slug",
            valueRequired: true,
            description: "Unique project slug; defaults to a slug derived from the name.",
          },
          {
            name: "description",
            valueRequired: true,
            description: "Project description.",
          },
        ],
        examples: [
          'projects.create --name "Customer Support"',
          'projects.create --name "Customer Support" --slug support --description "Support workflows" --format json',
        ],
      },
      parse: defineCliArgsParser<z.input<typeof projectCreateInputSchema>>("projects.create", {
        name: { kind: "string", required: true },
        slug: { kind: "string" },
        description: { kind: "string" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `Created project ${result.slug} (${result.projectId})\n` },
    },
  },
});

export const projectsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "projects",
  tools: [createProjectTool, listProjectsTool],
  isAvailable: (context: ProjectsToolContext) => !!context.runtimes.projects,
});
