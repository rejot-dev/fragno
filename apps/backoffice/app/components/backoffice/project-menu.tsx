import { Menu } from "@base-ui/react/menu";
import { ChevronsUpDown } from "lucide-react";
import { Link, useLocation } from "react-router";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

import { scopeSwitchPath } from "./scope-switch-path";

export type BackofficeProjectOption = {
  id: string;
  label: string;
};

const menuItemClassName = (isCurrent: boolean) =>
  isCurrent
    ? "grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left text-[var(--bo-accent-fg)] outline-none"
    : "grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left text-[var(--bo-muted)] outline-none transition-[background-color,border-color,color] duration-150 ease-out data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";

export function BackofficeProjectMenu({
  orgId,
  currentProjectId,
  projects,
  projectsError,
}: {
  orgId: string;
  currentProjectId: string | null;
  projects: BackofficeProjectOption[];
  projectsError: string | null;
}) {
  const location = useLocation();
  const currentProject = currentProjectId
    ? (projects.find((project) => project.id === currentProjectId) ?? {
        id: currentProjectId,
        label: currentProjectId,
      })
    : null;
  const createProjectPath = `/backoffice/automations/${backofficeContextScopeRoutePath({
    kind: "org",
    orgId,
  })}/dashboard?createProject=1`;

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label={`Switch project. Current project: ${currentProject?.label ?? "none"}`}
        className="group flex min-h-12 w-full min-w-0 cursor-pointer items-center gap-2.5 py-3.5 pr-5.5 pl-6 text-left transition-[scale,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[11px] font-semibold text-[var(--bo-muted-2)]">Project</span>
          <span
            className={`min-w-0 truncate text-sm tracking-normal normal-case ${currentProject ? "font-extrabold text-[var(--bo-fg)]" : "font-medium text-[var(--bo-muted-2)]"}`}
          >
            {currentProject?.label ?? "None"}
          </span>
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--bo-muted-2)] transition-colors duration-150 ease-out group-data-[popup-open]:text-[var(--bo-accent-fg)]"
        />
      </Menu.Trigger>

      <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Menu.Positioner side="bottom" align="start" sideOffset={0} style={{ zIndex: 2147483647 }}>
          <Menu.Popup
            data-backoffice-root
            className="relative max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] origin-top-left overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left tracking-normal text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
          >
            <p className="px-2 py-1 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Switch project
            </p>

            <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
            <Menu.Group className="space-y-1">
              {currentProject ? (
                <Menu.Item
                  render={
                    <Link
                      to={scopeSwitchPath(location.pathname, { kind: "org", orgId })}
                      preventScrollReset
                    />
                  }
                  className={menuItemClassName(false)}
                >
                  <span className="text-sm font-medium text-[var(--bo-fg)]">No project</span>
                  <span className="text-xs text-[var(--bo-muted-2)]">
                    Return to the organisation scope
                  </span>
                </Menu.Item>
              ) : null}
              {projects.map((project) => {
                const isCurrent = project.id === currentProject?.id;
                const content = (
                  <>
                    <span
                      className={`truncate text-sm tracking-normal text-[var(--bo-fg)] normal-case ${isCurrent ? "font-extrabold" : "font-medium"}`}
                    >
                      {project.label}
                    </span>
                    <span className="truncate text-xs tracking-normal text-[var(--bo-muted-2)] normal-case">
                      Project scope
                    </span>
                  </>
                );

                return isCurrent ? (
                  <Menu.Item key={project.id} disabled className={menuItemClassName(true)}>
                    {content}
                  </Menu.Item>
                ) : (
                  <Menu.Item
                    key={project.id}
                    render={
                      <Link
                        to={scopeSwitchPath(location.pathname, {
                          kind: "project",
                          orgId,
                          projectId: project.id,
                        })}
                        preventScrollReset
                      />
                    }
                    className={menuItemClassName(false)}
                  >
                    {content}
                  </Menu.Item>
                );
              })}
              {projects.length === 0 && !projectsError ? (
                <p className="px-2 py-1.5 text-xs text-[var(--bo-muted-2)]">
                  This organisation has no projects yet.
                </p>
              ) : null}
              {projectsError ? (
                <p className="px-2 py-1.5 text-xs text-red-700 dark:text-red-200">
                  {projectsError}
                </p>
              ) : null}
              <Menu.Item
                render={<Link to={createProjectPath} preventScrollReset />}
                className={menuItemClassName(false)}
              >
                <span className="text-sm font-medium text-[var(--bo-fg)]">+ New project</span>
                <span className="text-xs text-[var(--bo-muted-2)]">
                  Create a project-scoped runtime
                </span>
              </Menu.Item>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
