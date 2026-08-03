import { Menu } from "@base-ui/react/menu";
import { Fragment } from "react";
import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { BackofficeBreadcrumbs } from "@/components/backoffice/breadcrumbs";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";

import {
  automationUiScopeId,
  type AutomationScopeOption,
  type AutomationUiScope,
} from "../automations/scope";
import { filesScopeBasePath } from "./scope";

const FILE_SCOPE_GROUPS = [
  { kind: "system", label: "System" },
  { kind: "org", label: "Organisations" },
  { kind: "user", label: "Personal" },
  { kind: "project", label: "Projects" },
] as const;

const fileScopeKindLabel = (kind: AutomationUiScope["kind"]): string => {
  switch (kind) {
    case "system":
      return "System";
    case "org":
      return "Org";
    case "project":
      return "Project";
    case "user":
      return "User";
  }

  throw new Error("Unsupported Backoffice file scope kind.");
};

function FilesScopeMenu({
  selectedScope,
  scopeOptions,
  projectsError,
}: {
  selectedScope: AutomationUiScope;
  scopeOptions: AutomationScopeOption[];
  projectsError: string | null;
}) {
  const selectedId = automationUiScopeId(selectedScope);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label={`Switch file scope. Current context: ${selectedScope.label}`}
        className="group flex min-h-10 w-full min-w-0 items-center gap-2.5 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] py-2 pr-2.5 pl-3 text-left transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none hover:border-[color:var(--bo-border-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:border-[color:var(--bo-accent)] data-[popup-open]:bg-[var(--bo-accent-bg)]"
      >
        <span className="hidden shrink-0 text-[8px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase group-data-[popup-open]:text-[var(--bo-accent-fg)] lg:inline">
          File scope
        </span>
        <span
          className="hidden h-4 w-px shrink-0 bg-[var(--bo-border-strong)] lg:block"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            {fileScopeKindLabel(selectedScope.kind)}
          </span>
          <span className="text-[var(--bo-muted-2)]" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
            {selectedScope.label}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180 group-data-[popup-open]:text-[var(--bo-accent-fg)]"
        >
          ▾
        </span>
      </Menu.Trigger>

      <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Menu.Positioner side="bottom" align="end" sideOffset={10} style={{ zIndex: 2147483647 }}>
          <Menu.Popup
            data-backoffice-root
            className="relative max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] origin-top-left overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left tracking-normal text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
          >
            <p className="px-2 py-1 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Switch file scope
            </p>
            {FILE_SCOPE_GROUPS.map((group) => {
              const options = scopeOptions.filter((option) => option.kind === group.kind);
              const showProjectsError = group.kind === "project" && projectsError;
              if (options.length === 0 && !showProjectsError) {
                return null;
              }

              return (
                <Fragment key={group.kind}>
                  <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
                  <Menu.Group className="space-y-1">
                    <Menu.GroupLabel className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      {group.label}
                    </Menu.GroupLabel>
                    {options.map((option) => {
                      const isCurrent = option.id === selectedId;
                      const className = isCurrent
                        ? "grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left text-[var(--bo-accent-fg)] outline-none"
                        : "grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left text-[var(--bo-muted)] outline-none transition-[background-color,border-color,color] duration-150 ease-out data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";
                      const content = (
                        <>
                          <span className="flex min-w-0 items-center justify-between gap-4">
                            <span className="truncate text-sm font-medium tracking-normal text-[var(--bo-fg)] normal-case">
                              {option.label}
                            </span>
                            <span className="shrink-0 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                              {fileScopeKindLabel(option.kind)}
                            </span>
                          </span>
                          <span className="truncate text-xs tracking-normal text-[var(--bo-muted-2)] normal-case">
                            {option.description}
                          </span>
                        </>
                      );

                      return isCurrent ? (
                        <Menu.Item key={option.id} disabled className={className}>
                          {content}
                        </Menu.Item>
                      ) : (
                        <Menu.Item
                          key={option.id}
                          render={<Link to={option.to} preventScrollReset />}
                          className={className}
                        >
                          {content}
                        </Menu.Item>
                      );
                    })}
                    {showProjectsError ? (
                      <p className="px-2 py-1.5 text-xs text-red-700 dark:text-red-200">
                        {projectsError}
                      </p>
                    ) : null}
                  </Menu.Group>
                </Fragment>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function FilesWorkspaceHeader({
  selectedScope,
  scopeOptions,
  projectsError,
}: {
  selectedScope: AutomationUiScope;
  scopeOptions: AutomationScopeOption[];
  projectsError: string | null;
}) {
  const basePath = filesScopeBasePath(selectedScope);

  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Files for {selectedScope.label}</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bo-product-code">FIL</span>
            <BackofficeBreadcrumbs
              items={[{ label: "Backoffice", to: "/backoffice" }, { label: "Files" }]}
            />
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:max-w-md">
            <FilesScopeMenu
              selectedScope={selectedScope}
              scopeOptions={scopeOptions}
              projectsError={projectsError}
            />
          </div>
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
        <OverflowTabRow
          items={[{ id: "explorer", label: "Explorer", to: basePath, active: true }]}
          ariaLabel="File workspace sections"
        />
      </div>
    </section>
  );
}

export function FilesErrorBoundary({
  error,
  params,
}: {
  error: unknown;
  params: { scopeKind?: string; scopeId?: string };
}) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
    message = typeof error.data === "string" ? error.data : message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  if (statusCode === 404 && params.scopeKind && params.scopeId) {
    message = `File scope '${params.scopeKind}:${params.scopeId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Files", to: "/backoffice/files" },
          { label: "Error" },
        ]}
        eyebrow="Workspace"
        title="File workspace unavailable"
        description="The requested scoped filesystem could not be opened."
      />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
