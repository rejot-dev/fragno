import { useLiveQuery } from "@tanstack/react-db";

import type { AutomationBrowserCollections } from "./browser-database";

type AutomationProjectListItem = {
  id: string;
  slug: string;
  name: string;
  archivedAt: Date | null;
};

type AutomationProjectsLiveState =
  | { status: "loading"; projects: [] }
  | { status: "ready"; projects: AutomationProjectListItem[] }
  | { status: "error"; projects: AutomationProjectListItem[]; message: string };

/** Reads organization projects from the local-first synchronized Automations collection. */
export function useAutomationProjects(
  collections: AutomationBrowserCollections,
): AutomationProjectsLiveState {
  const projectsQuery = useLiveQuery(
    (query) =>
      query
        .from({ project: collections.projects })
        .orderBy(({ project }) => project.slug, "asc")
        .select(({ project }) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          archivedAt: project.archivedAt,
        })),
    [collections.projects],
  );
  const projects = (projectsQuery.data ?? []).filter((project) => project.archivedAt === null);

  if (projectsQuery.isError) {
    return {
      status: "error",
      projects,
      message: "Project synchronization failed.",
    };
  }
  if (projectsQuery.isLoading && projects.length === 0) {
    return { status: "loading", projects: [] };
  }
  return { status: "ready", projects };
}
