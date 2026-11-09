import {
  SelectorMenu,
  SelectorMenuGroup,
  SelectorMenuHeading,
  SelectorMenuNote,
  SelectorMenuOption,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/controls/selector-menu";
import { SheetOption, SheetSection } from "@fragno-private/design-system/overlays/sheet";
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

type ProjectChoice = {
  key: string;
  to: string;
  label: string;
  description: string;
  current: boolean;
};

/**
 * Where the menu and the sheet can go: out of the project or to another one, and to a new one, which
 * follows any note about the list.
 */
function projectChoices({
  pathname,
  owner,
  ownerScope,
  currentProject,
  projects,
}: {
  pathname: string;
  owner: BackofficeProjectMenuOwner;
  ownerScope: string;
  currentProject: BackofficeProjectOption | null;
  projects: BackofficeProjectOption[];
}): { switches: ProjectChoice[]; create: ProjectChoice } {
  return {
    switches: [
      ...(currentProject
        ? [
            {
              key: "no-project",
              to: scopeSwitchPath(pathname, owner),
              label: "No project",
              description: `Return to ${ownerScope}`,
              current: false,
            },
          ]
        : []),
      ...projects.map((project) => ({
        key: project.slug,
        to: scopeSwitchPath(pathname, { kind: "project", owner, projectSlug: project.slug }),
        label: project.label,
        description: "Project scope",
        current: project.slug === currentProject?.slug,
      })),
    ],
    create: {
      key: "new-project",
      to: `/backoffice/dashboard/${backofficeRouteScopePath(owner)}?createProject=1`,
      label: "+ New project",
      description: "Create a project-scoped runtime",
      current: false,
    },
  };
}

type ProjectListProps = {
  owner: BackofficeProjectMenuOwner;
  administeredMember: AdministeredMember | null;
  currentProject: BackofficeProjectOption | null;
  projects: BackofficeProjectOption[];
  projectsError: string | null;
  projectsLoading: boolean;
};

export function BackofficeProjectMenu({
  owner,
  administeredMember,
  currentProject,
  projects,
  projectsError,
  projectsLoading,
}: ProjectListProps) {
  const location = useLocation();
  const description = ownerDescription(owner, administeredMember);
  const choices = projectChoices({
    pathname: location.pathname,
    owner,
    ownerScope: description.scope,
    currentProject,
    projects,
  });

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
          {choices.switches.map((choice) => (
            <SelectorMenuOption
              key={choice.key}
              to={choice.to}
              label={choice.label}
              description={choice.description}
              badge={null}
              current={choice.current}
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
            to={choices.create.to}
            label={choices.create.label}
            description={choices.create.description}
            badge={null}
            current={false}
          />
        </SelectorMenuGroup>
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}

/** The project choices as a section of the phone's workspace sheet. */
function BackofficeProjectSheetSection({
  owner,
  administeredMember,
  currentProject,
  projects,
  projectsError,
  projectsLoading,
}: ProjectListProps) {
  const location = useLocation();
  const description = ownerDescription(owner, administeredMember);
  const choices = projectChoices({
    pathname: location.pathname,
    owner,
    ownerScope: description.scope,
    currentProject,
    projects,
  });

  return (
    <SheetSection label="Project">
      {choices.switches.map((choice) => (
        <SheetOption
          key={choice.key}
          to={choice.to}
          label={choice.label}
          description={choice.description}
          current={choice.current}
        />
      ))}
      {projectsLoading ? (
        <p className="px-3 text-xs text-[var(--bo-muted-2)]">Loading projects…</p>
      ) : projects.length === 0 && !projectsError ? (
        <p className="px-3 text-xs text-[var(--bo-muted-2)]">
          {description.name} has no projects yet.
        </p>
      ) : null}
      {projectsError ? (
        <p role="alert" className="px-3 text-xs text-[var(--bo-failed)]">
          {projectsError}
        </p>
      ) : null}
      <SheetOption
        to={choices.create.to}
        label={choices.create.label}
        description={choices.create.description}
        current={false}
      />
    </SheetSection>
  );
}

const EMPTY_PROJECTS: BackofficeProjectOption[] = [];

/**
 * The project menu, or the workspace sheet's project section, which lists the owner's projects
 * once the layout's loader streams them in.
 */
export function StreamedBackofficeProjectMenu({
  presentation,
  owner,
  administeredMember,
  currentProject,
  projectList,
}: {
  presentation: "menu" | "sheet";
  owner: BackofficeProjectMenuOwner;
  administeredMember: AdministeredMember | null;
  currentProject: BackofficeProjectOption | null;
  projectList: Promise<AutomationProjectList> | null;
}) {
  const Presentation =
    presentation === "menu" ? BackofficeProjectMenu : BackofficeProjectSheetSection;
  const menu = (list: AutomationProjectList | null) => (
    <Presentation
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
