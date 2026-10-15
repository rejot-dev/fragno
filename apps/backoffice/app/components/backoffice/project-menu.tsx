import {
  SelectorMenu,
  SelectorMenuGroup,
  SelectorMenuHeading,
  SelectorMenuNote,
  SelectorMenuOption,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/selector-menu";
import { useLocation } from "react-router";

import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

import { scopeSwitchPath } from "./scope-switch-path";

export type BackofficeProjectOption = {
  slug: string;
  label: string;
};

export function BackofficeProjectMenu({
  orgSlug,
  currentProject,
  projects,
  projectsError,
  projectsLoading,
}: {
  orgSlug: string;
  currentProject: BackofficeProjectOption | null;
  projects: BackofficeProjectOption[];
  projectsError: string | null;
  projectsLoading: boolean;
}) {
  const location = useLocation();
  const organizationRouteScope = { kind: "org", orgSlug } as const;
  const createProjectPath = `/backoffice/dashboard/${backofficeRouteScopePath(organizationRouteScope)}?createProject=1`;

  return (
    <SelectorMenu>
      <SelectorMenuTrigger
        label="Project"
        value={currentProject?.label ?? null}
        ariaLabel={`Switch project. Current project: ${currentProject?.label ?? "none"}`}
        layout={{ kind: "fill" }}
      />

      <SelectorMenuPopup align="start" height="capped">
        <SelectorMenuHeading>Switch project</SelectorMenuHeading>

        <SelectorMenuGroup label={null}>
          {currentProject ? (
            <SelectorMenuOption
              to={scopeSwitchPath(location.pathname, organizationRouteScope)}
              label="No project"
              description="Return to the organization scope"
              badge={null}
              current={false}
            />
          ) : null}
          {projects.map((project) => (
            <SelectorMenuOption
              key={project.slug}
              to={scopeSwitchPath(location.pathname, {
                kind: "project",
                owner: organizationRouteScope,
                projectSlug: project.slug,
              })}
              label={project.label}
              description="Project scope"
              badge={null}
              current={project.slug === currentProject?.slug}
            />
          ))}
          {projectsLoading ? (
            <SelectorMenuNote tone="muted">Synchronizing projects…</SelectorMenuNote>
          ) : projects.length === 0 && !projectsError ? (
            <SelectorMenuNote tone="muted">This organization has no projects yet.</SelectorMenuNote>
          ) : null}
          {projectsError ? <SelectorMenuNote tone="error">{projectsError}</SelectorMenuNote> : null}
          <SelectorMenuOption
            to={createProjectPath}
            label="+ New project"
            description="Create a project-scoped runtime"
            badge={null}
            current={false}
          />
        </SelectorMenuGroup>
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}
