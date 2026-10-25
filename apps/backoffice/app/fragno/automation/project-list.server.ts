import { projectPageSchema } from "@fragno-dev/backoffice-api/v0/projects";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeWorkerContextValue } from "@/worker-runtime/router-context";

import type { AutomationProjectList } from "./project-list";

const PROJECTS_PER_PAGE = 100;

/**
 * Lists a workspace's projects from its Automations object, every page of them. Failures resolve
 * as a listing that failed, so a page that streams the list renders without it instead of failing.
 */
export async function loadAutomationProjectList(
  request: Request,
  workerContext: BackofficeWorkerContextValue,
  owner: BackofficeResolvedScope,
): Promise<AutomationProjectList> {
  const automations = workerContext.kernel.scoped(
    "AUTOMATIONS",
    backofficeRuntimeScopeFromResolvedScope(owner),
    workerContext.runtime.objects.automations,
  );
  try {
    const projects: { slug: string; name: string }[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL("/api/automations/projects", request.url);
      url.searchParams.set("pageSize", String(PROJECTS_PER_PAGE));
      if (cursor !== null) {
        url.searchParams.set("cursor", cursor);
      }
      const response = await automations.http.fetch(new Request(url, { signal: request.signal }));
      if (!response.ok) {
        throw new Error(`Listing projects returned ${response.status}.`);
      }
      const page = projectPageSchema.parse(await response.json());
      for (const project of page.projects) {
        if (project.archivedAt === null) {
          projects.push({ slug: project.slug, name: project.name });
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor !== null);
    return { kind: "listed", projects };
  } catch (error) {
    console.error("Listing projects for the project menu failed.", error);
    return { kind: "failed", message: "Projects could not be loaded." };
  }
}
