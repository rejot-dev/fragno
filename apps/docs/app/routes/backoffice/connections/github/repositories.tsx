import { Link, Outlet, redirect, useLoaderData, useOutletContext, useParams } from "react-router";
import type { Route } from "./+types/repositories";
import {
  fetchGitHubAdminConfig,
  fetchGitHubLinkedRepositories,
  type GitHubRepositorySummary,
} from "./data";
import type { GitHubLayoutContext } from "./shared";

type GitHubRepositoriesLoaderData = {
  configError: string | null;
  reposError: string | null;
  repos: GitHubRepositorySummary[];
};

export type GitHubRepositoriesOutletContext = {
  repos: GitHubRepositorySummary[];
  selectedRepoId: string | null;
  basePath: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const { configState, configError } = await fetchGitHubAdminConfig(context, params.orgId, origin);
  if (configError) {
    return {
      configError,
      reposError: null,
      repos: [],
    } satisfies GitHubRepositoriesLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/github/${params.orgId}/configuration`);
  }

  const { repos, reposError } = await fetchGitHubLinkedRepositories(request, context, params.orgId);
  return {
    configError: null,
    reposError,
    repos,
  } satisfies GitHubRepositoriesLoaderData;
}

export default function BackofficeOrganisationGitHubRepositories() {
  const { repos, configError, reposError } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<GitHubLayoutContext>();
  const { repoId } = useParams();
  const selectedRepoId = repoId ?? null;
  const basePath = `/backoffice/connections/github/${orgId}/repositories`;
  const isDetailRoute = Boolean(selectedRepoId);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (reposError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{reposError}</div>
    );
  }

  if (!repos.length) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No linked repositories yet. Use the Configuration tab to link repositories first.
      </div>
    );
  }

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.45fr]">
      <div
        className={`${listVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Repositories
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Linked repositories</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
            {repos.length} total
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {repos.map((repo) => {
            const isSelected = repo.id === selectedRepoId;
            return (
              <Link
                key={repo.id}
                to={`${basePath}/${repo.id}`}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-left text-[var(--bo-accent-fg)]"
                    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">{repo.fullName}</p>
                    <p className="text-xs text-[var(--bo-muted-2)]">
                      Installation {repo.installationId} ·{" "}
                      {repo.defaultBranch ? `default ${repo.defaultBranch}` : "no default branch"}
                    </p>
                  </div>
                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] uppercase tracking-[0.22em]">
                    {repo.isPrivate ? "Private" : "Public"}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div
        className={`${detailVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <Outlet
          context={{
            repos,
            selectedRepoId,
            basePath,
          }}
        />
      </div>
    </section>
  );
}
