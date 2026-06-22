import type { ReactNode } from "react";
import {
  Form,
  Link,
  isRouteErrorResponse,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import {
  archiveAutomationProject,
  createAutomationProject,
  fetchAutomationProjects,
  toExternalId,
  updateAutomationProject,
} from "../automations/data";
import { formatTimestamp } from "../automations/shared";
import {
  getRouteErrorMessage,
  isOrganisationNotFoundError,
  throwOrganisationNotFound,
} from "../route-errors";
import type { Route } from "./+types/organisation";

type ProjectItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archivedAt?: string | Date | null;
  createdByUserId: string;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type ProjectActionData = {
  ok: false;
  message: string;
};

const optionalText = (value: FormDataEntryValue | null) => {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
};

const nullableText = (value: FormDataEntryValue | null) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const normalizeProjects = (
  storedProjects: Awaited<ReturnType<typeof fetchAutomationProjects>>["projects"],
) => {
  const projects: ProjectItem[] = storedProjects.map((project, index) => ({
    id: toExternalId(project.id) || `project-${index}`,
    slug: project.slug?.trim() || "project",
    name: project.name?.trim() || "Untitled project",
    description: project.description ?? null,
    archivedAt: project.archivedAt ?? null,
    createdByUserId: project.createdByUserId?.trim() || "—",
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
  }));

  return projects.sort(
    (left, right) =>
      Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) ||
      left.name.localeCompare(right.name) ||
      left.slug.localeCompare(right.slug),
  );
};

const buildProjectsPath = ({
  orgId,
  projectId,
  isCreating = false,
}: {
  orgId: string;
  projectId?: string | null;
  isCreating?: boolean;
}) => {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("project", projectId);
  }
  if (isCreating) {
    params.set("new", "1");
  }

  const suffix = params.toString();
  return `/backoffice/projects/${orgId}${suffix ? `?${suffix}` : ""}`;
};

const requireProjectActionUser = async ({ request, params, context }: Route.ActionArgs) => {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const hasOrganisation = me.organizations.some((entry) => entry.organization.id === params.orgId);
  if (!hasOrganisation) {
    throwOrganisationNotFound(params.orgId);
  }

  return { userId: me.user.id, orgId: params.orgId };
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throwOrganisationNotFound(params.orgId);
  }

  const projectsResult = await fetchAutomationProjects(request, context, params.orgId);

  return {
    orgId: params.orgId,
    organisation,
    projects: normalizeProjects(projectsResult.projects),
    projectsError: projectsResult.projectsError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `Projects · ${orgId}` }];
}

export async function action(args: Route.ActionArgs) {
  const { request, context } = args;
  const { userId, orgId } = await requireProjectActionUser(args);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "").trim();

  if (intent === "create-project") {
    const name = optionalText(formData.get("name"));
    if (!name) {
      return { ok: false, message: "Project name is required." } satisfies ProjectActionData;
    }

    const result = await createAutomationProject(request, context, orgId, {
      name,
      slug: optionalText(formData.get("slug")),
      description: nullableText(formData.get("description")),
      createdByUserId: userId,
    });

    if (result.error || !result.project) {
      return {
        ok: false,
        message: result.error ?? "Unable to create project.",
      } satisfies ProjectActionData;
    }

    return redirect(
      buildProjectsPath({
        orgId,
        projectId: toExternalId(result.project.id),
      }),
    );
  }

  if (intent === "update-project") {
    const projectId = optionalText(formData.get("projectId"));
    const name = optionalText(formData.get("name"));
    if (!projectId) {
      return { ok: false, message: "Project id is required." } satisfies ProjectActionData;
    }
    if (!name) {
      return { ok: false, message: "Project name is required." } satisfies ProjectActionData;
    }

    const result = await updateAutomationProject(request, context, orgId, projectId, {
      name,
      slug: optionalText(formData.get("slug")),
      description: nullableText(formData.get("description")),
    });

    if (result.error || !result.project) {
      return {
        ok: false,
        message: result.error ?? "Unable to update project.",
      } satisfies ProjectActionData;
    }

    return redirect(
      buildProjectsPath({
        orgId,
        projectId: toExternalId(result.project.id) || projectId,
      }),
    );
  }

  if (intent === "archive-project") {
    const projectId = optionalText(formData.get("projectId"));
    if (!projectId) {
      return { ok: false, message: "Project id is required." } satisfies ProjectActionData;
    }

    const result = await archiveAutomationProject(request, context, orgId, projectId);
    if (result.error || !result.project) {
      return {
        ok: false,
        message: result.error ?? "Unable to archive project.",
      } satisfies ProjectActionData;
    }

    return redirect(buildProjectsPath({ orgId }));
  }

  return { ok: false, message: "Unknown project action." } satisfies ProjectActionData;
}

function ProjectsHeader({
  orgId,
  organisationName,
}: {
  orgId: string;
  organisationName?: string | null;
}) {
  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Projects", to: "/backoffice/projects" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Projects"
      title={`Projects for ${organisationName ?? orgId}`}
      description="Create and manage automation projects for this organisation. Projects provide scoped automation runtimes and storage."
      actions={
        <Link
          to={`/backoffice/organisations/${orgId}`}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          View organisation
        </Link>
      }
    />
  );
}

function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "error" }) {
  return (
    <div
      className={
        tone === "error"
          ? "border border-red-400/40 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-200"
          : "border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-sm text-[var(--bo-muted)]"
      }
    >
      {children}
    </div>
  );
}

const buildProjectLink = ({ basePath, projectId }: { basePath: string; projectId: string }) => {
  const params = new URLSearchParams({ project: projectId });
  return `${basePath}?${params.toString()}`;
};

function ProjectListItem({
  basePath,
  project,
  isSelected,
}: {
  basePath: string;
  project: ProjectItem;
  isSelected: boolean;
}) {
  const isArchived = Boolean(project.archivedAt);

  return (
    <Link
      to={buildProjectLink({ basePath, projectId: project.id })}
      preventScrollReset
      aria-current={isSelected ? "page" : undefined}
      className={
        isSelected
          ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
          : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">{project.name}</p>
          <p className="mt-1 truncate font-mono text-xs text-[var(--bo-muted-2)]">{project.slug}</p>
        </div>
        {isArchived ? (
          <span className="shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
            Archived
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
        Updated {formatTimestamp(project.updatedAt)}
      </p>
      <p className="mt-2 line-clamp-2 text-xs text-[var(--bo-muted)]">
        {project.description || "No description yet."}
      </p>
    </Link>
  );
}

function ProjectForm({ project, isSubmitting }: { project?: ProjectItem; isSubmitting: boolean }) {
  const isEditing = Boolean(project);

  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value={isEditing ? "update-project" : "create-project"} />
      {project ? <input type="hidden" name="projectId" value={project.id} /> : null}

      <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
        <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Name
        </span>
        <input
          name="name"
          required
          maxLength={160}
          defaultValue={project?.name ?? ""}
          placeholder="Launch Plan"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
        <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Slug
        </span>
        <input
          name="slug"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={80}
          defaultValue={project?.slug ?? ""}
          placeholder="launch-plan"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-xs text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
        />
        <span className="text-[11px] text-[var(--bo-muted-2)]">
          Lowercase letters, numbers, and single hyphens. Leave blank on create to generate one.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
        <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Description
        </span>
        <textarea
          name="description"
          maxLength={1000}
          rows={5}
          defaultValue={project?.description ?? ""}
          placeholder="What this project owns."
          className="resize-y border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
        />
      </label>

      <button
        type="submit"
        disabled={isSubmitting}
        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting
          ? isEditing
            ? "Saving…"
            : "Creating…"
          : isEditing
            ? "Save project"
            : "Create project"}
      </button>
    </Form>
  );
}

export default function BackofficeOrganisationProjects() {
  const { orgId, organisation, projects, projectsError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const selectedProjectId = searchParams.get("project")?.trim() ?? "";
  const isCreating = searchParams.get("new") === "1";
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const isDetailVisible = Boolean(selectedProject || isCreating);
  const basePath = `/backoffice/projects/${orgId}`;
  const pendingIntent =
    navigation.state === "submitting" ? String(navigation.formData?.get("intent") ?? "") : "";
  const pendingProjectId =
    navigation.state === "submitting" ? String(navigation.formData?.get("projectId") ?? "") : "";
  const newProjectLinkClass = isCreating
    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]";

  return (
    <div className="space-y-4">
      <ProjectsHeader orgId={orgId} organisationName={organisation.name} />

      {projectsError && projects.length === 0 ? (
        <Notice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">Could not load projects</p>
          <p className="mt-2 text-sm">{projectsError}</p>
        </Notice>
      ) : (
        <section className="space-y-4">
          {actionData?.message ? (
            <Notice tone="error">
              <p className="text-[10px] tracking-[0.22em] uppercase">Project action failed</p>
              <p className="mt-2 text-sm">{actionData.message}</p>
            </Notice>
          ) : null}

          {projectsError ? (
            <Notice tone="error">
              <p className="text-[10px] tracking-[0.22em] uppercase">Could not load all projects</p>
              <p className="mt-2 text-sm">{projectsError}</p>
            </Notice>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
            <div
              className={`${isDetailVisible ? "hidden lg:block" : "block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    Projects
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                    Project overview
                  </h2>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                  {projects.length} total
                </span>
              </div>

              <div className="mt-4 space-y-2">
                <Link
                  to={buildProjectsPath({
                    orgId,
                    isCreating: true,
                  })}
                  className={newProjectLinkClass}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">New project</p>
                    <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
                      Create
                    </span>
                  </div>
                </Link>

                {projects.length ? (
                  projects.map((project) => (
                    <ProjectListItem
                      key={project.id}
                      basePath={basePath}
                      project={project}
                      isSelected={project.id === selectedProjectId}
                    />
                  ))
                ) : (
                  <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
                    No projects yet. Use the new project button above to get started.
                  </div>
                )}
              </div>
            </div>

            <div
              className={`${isDetailVisible ? "block" : "hidden lg:block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
            >
              {selectedProject ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2 lg:hidden">
                        <Link
                          to={buildProjectsPath({
                            orgId,
                          })}
                          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                        >
                          Back to list
                        </Link>
                      </div>
                      <div>
                        <p className="font-mono text-[11px] text-[var(--bo-muted-2)]">
                          {selectedProject.slug}
                        </p>
                        <h2 className="mt-1 text-2xl font-semibold text-[var(--bo-fg)]">
                          {selectedProject.name}
                        </h2>
                      </div>
                    </div>
                    {selectedProject.archivedAt ? (
                      <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                        Archived
                      </span>
                    ) : null}
                  </div>

                  <div className="grid gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)] sm:grid-cols-3">
                    <div>
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Created
                      </p>
                      <p className="mt-1 text-[var(--bo-fg)]">
                        {formatTimestamp(selectedProject.createdAt)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Updated
                      </p>
                      <p className="mt-1 text-[var(--bo-fg)]">
                        {formatTimestamp(selectedProject.updatedAt)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        Created by
                      </p>
                      <p className="mt-1 font-mono text-[var(--bo-fg)]">
                        {selectedProject.createdByUserId}
                      </p>
                    </div>
                  </div>

                  <ProjectForm
                    project={selectedProject}
                    isSubmitting={
                      pendingIntent === "update-project" && pendingProjectId === selectedProject.id
                    }
                  />

                  {!selectedProject.archivedAt ? (
                    <div className="border border-red-400/30 bg-red-500/6 p-4">
                      <p className="text-sm font-medium text-red-700 dark:text-red-200">
                        Archive this project
                      </p>
                      <p className="mt-1 text-xs text-red-700/80 dark:text-red-200/80">
                        Archived projects stay visible in the project list with an archived badge.
                      </p>
                      <Form method="post" className="mt-3">
                        <input type="hidden" name="intent" value="archive-project" />
                        <input type="hidden" name="projectId" value={selectedProject.id} />
                        <button
                          type="submit"
                          disabled={
                            pendingIntent === "archive-project" &&
                            pendingProjectId === selectedProject.id
                          }
                          className="border border-red-400/40 bg-red-500/8 px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-red-700 uppercase transition-colors hover:border-red-400/60 hover:bg-red-500/12 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-200"
                        >
                          {pendingIntent === "archive-project" &&
                          pendingProjectId === selectedProject.id
                            ? "Archiving…"
                            : "Archive project"}
                        </button>
                      </Form>
                    </div>
                  ) : null}
                </div>
              ) : isCreating ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 lg:hidden">
                    <Link
                      to={buildProjectsPath({ orgId })}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Back to list
                    </Link>
                  </div>
                  <div>
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      New project
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">
                      Create project
                    </h2>
                  </div>
                  <ProjectForm
                    project={undefined}
                    isSubmitting={pendingIntent === "create-project"}
                  />
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-sm text-[var(--bo-muted)]">
                    Select a project to manage it, or create a new project for this organisation.
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
  }

  message = getRouteErrorMessage(error, message);

  if (statusCode === 404 && params.orgId && isOrganisationNotFoundError(error)) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <ProjectsHeader orgId={params.orgId ?? "organisation"} organisationName="Error" />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
