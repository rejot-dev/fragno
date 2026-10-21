import type {
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectPage,
} from "@fragno-dev/backoffice-api/v0/projects";
import type { DirectoryPageInput } from "@fragno-dev/backoffice-api/v0/shared/pagination";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type {
  AutomationsObject,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

export type ProjectsRuntime = {
  list(input: DirectoryPageInput): Promise<ProjectPage>;
  create(input: ProjectCreateInput): Promise<ProjectCreateResult>;
};

export function createProjectsRuntime({
  object,
  execution,
  userId,
}: {
  object: BackofficeObjectHandle<AutomationsObject>;
  execution: BackofficeExecutionContext;
  userId: string;
}): ProjectsRuntime {
  const callRoute = createAutomationsRouteCaller({ object, context: { execution } });

  return {
    async list(input) {
      const query = new URLSearchParams({ pageSize: String(input.pageSize) });
      if (input.cursor !== null) {
        query.set("cursor", input.cursor);
      }
      const response = await callRoute("GET", "/projects", { query });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Automations backend",
        label: "projects.list",
      });
    },
    async create(input) {
      const response = await callRoute("POST", "/projects", {
        body: {
          name: input.name,
          slug: input.slug ?? undefined,
          description: input.description,
          createdByUserId: userId,
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        // The route serializes the database ID as its external string value.
        return { projectId: response.data.id as string, slug: response.data.slug };
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Automations backend",
        label: "projects.create",
      });
    },
  };
}
