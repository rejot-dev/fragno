import {
  SelectorMenu,
  SelectorMenuGroup,
  SelectorMenuHeading,
  SelectorMenuNote,
  SelectorMenuOption,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/selector-menu";
import { Suspense, use, type ReactNode } from "react";
import { useLocation } from "react-router";

import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { AdministeredMember } from "@/fragno/auth/contracts";
import type { AutomationProjectList } from "@/fragno/automation/project-list";

import { scopeSwitchPath } from "./scope-switch-path";

export type BackofficeProjectOption = {
  slug: string;
  label: string;
};

/** The workspace whose projects the menu lists, as page URLs name it. */
export type BackofficeProjectMenuOwner = Extract<
  BackofficeRouteScope,
  { kind: "project" }
>["owner"];

function ownerDescription(
  owner: BackofficeProjectMenuOwner,
  administeredMember: AdministeredMember | null,
): { name: string; scope: string } {
  switch (owner.kind) {
    case "org":
      return { name: "This organization", scope: "the organization scope" };
    case "user":
      return administeredMember?.userId === owner.userId
        ? {
            name: `${administeredMember.email}'s personal workspace`,
            scope: `${administeredMember.email}'s personal scope`,
          }
        : { name: "Your personal workspace", scope: "your personal scope" };
    case "app":
      return { name: "This app", scope: "the app's workspace" };
    default:
      throw new Error("Unsupported project owner kind.", { cause: owner satisfies never });
  }
}

export function BackofficeProjectMenu({
  owner,
  administeredMember,
  currentProject,
  projects,
  projectsError,
  projectsLoading,
}: {
  owner: BackofficeProjectMenuOwner;
  administeredMember: AdministeredMember | null;
  currentProject: BackofficeProjectOption | null;
  projects: BackofficeProjectOption[];
  projectsError: string | null;
  projectsLoading: boolean;
}) {
  const location = useLocation();
  const description = ownerDescription(owner, administeredMember);
  const createProjectPath = `/backoffice/dashboard/${backofficeRouteScopePath(owner)}?createProject=1`;

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
              to={scopeSwitchPath(location.pathname, owner)}
              label="No project"
              description={`Return to ${description.scope}`}
              badge={null}
              current={false}
            />
          ) : null}
          {projects.map((project) => (
            <SelectorMenuOption
              key={project.slug}
              to={scopeSwitchPath(location.pathname, {
                kind: "project",
                owner,
                projectSlug: project.slug,
              })}
              label={project.label}
              description="Project scope"
              badge={null}
              current={project.slug === currentProject?.slug}
            />
          ))}
          {projectsLoading ? (
            <SelectorMenuNote tone="muted">Loading projects…</SelectorMenuNote>
          ) : projects.length === 0 && !projectsError ? (
            <SelectorMenuNote tone="muted">
              {description.name} has no projects yet.
            </SelectorMenuNote>
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

const EMPTY_PROJECTS: BackofficeProjectOption[] = [];

/** The project menu, which lists the owner's projects once the layout's loader streams them in. */
export function StreamedBackofficeProjectMenu({
  owner,
  administeredMember,
  currentProject,
  projectList,
}: {
  owner: BackofficeProjectMenuOwner;
  administeredMember: AdministeredMember | null;
  currentProject: BackofficeProjectOption | null;
  projectList: Promise<AutomationProjectList> | null;
}) {
  const menu = (list: AutomationProjectList | null) => (
    <BackofficeProjectMenu
      owner={owner}
      administeredMember={administeredMember}
      currentProject={currentProject}
      projects={
        list?.kind === "listed"
          ? list.projects.map((project) => ({
              slug: project.slug,
              label: project.name.trim() || project.slug,
            }))
          : EMPTY_PROJECTS
      }
      projectsError={list?.kind === "failed" ? list.message : null}
      projectsLoading={list === null}
    />
  );
  if (!projectList) {
    return menu({ kind: "failed", message: "Projects are unavailable here." });
  }
  return (
    <Suspense fallback={menu(null)}>
      <ListedProjects projectList={projectList}>{menu}</ListedProjects>
    </Suspense>
  );
}

function ListedProjects({
  projectList,
  children,
}: {
  projectList: Promise<AutomationProjectList>;
  children: (list: AutomationProjectList) => ReactNode;
}) {
  return children(use(projectList));
}
