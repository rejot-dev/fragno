import { Link, useLoaderData, useOutletContext, useParams } from "react-router";

import type { Route } from "./+types/repository-detail";
import {
  fetchGitHubLinkedRepositories,
  fetchGitHubPulls,
  type GitHubRepositorySummary,
} from "./data";
import type { GitHubRepositoriesOutletContext } from "./repositories";
import { formatTimestamp } from "./shared";

type GitHubRepositoryDetailLoaderData = {
  repo: GitHubRepositorySummary | null;
  pulls: Array<Record<string, unknown>>;
  pullsError: string | null;
  error: string | null;
  pageInfo: {
    page: number;
    perPage: number;
  } | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asBoolean = (value: unknown) => (typeof value === "boolean" ? value : null);

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.repoId) {
    throw new Response("Not Found", { status: 404 });
  }

  const linkedResult = await fetchGitHubLinkedRepositories(request, context, params.orgId);
  if (linkedResult.reposError) {
    return {
      repo: null,
      pulls: [],
      pullsError: null,
      error: linkedResult.reposError,
      pageInfo: null,
    } satisfies GitHubRepositoryDetailLoaderData;
  }

  const repo = linkedResult.repos.find((candidate) => candidate.id === params.repoId) ?? null;
  if (!repo) {
    return {
      repo: null,
      pulls: [],
      pullsError: null,
      error: "The selected repository is no longer linked.",
      pageInfo: null,
    } satisfies GitHubRepositoryDetailLoaderData;
  }

  const pullsResult = await fetchGitHubPulls(request, context, params.orgId, {
    owner: repo.ownerLogin,
    repo: repo.name,
    state: "open",
    perPage: 30,
    page: 1,
  });

  return {
    repo,
    pulls: pullsResult.pulls,
    pullsError: pullsResult.pullsError,
    error: null,
    pageInfo: pullsResult.pageInfo,
  } satisfies GitHubRepositoryDetailLoaderData;
}

export default function BackofficeOrganisationGitHubRepositoryDetail() {
  const { repo, pulls, pullsError, error, pageInfo } = useLoaderData<typeof loader>();
  const { basePath } = useOutletContext<GitHubRepositoriesOutletContext>();
  const { repoId } = useParams();

  if (error || !repoId || !repo) {
    return (
      <div className="space-y-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Repository detail
        </p>
        <p>{error ?? "Repository not found."}</p>
        <Link
          to={basePath}
          className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to repositories
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Repository
          </p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{repo.fullName}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">
            ID: {repo.id} · Installation {repo.installationId}
          </p>
        </div>
        <Link
          to={basePath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to repositories
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Repo metadata
          </p>
          <p className="mt-2 text-[var(--bo-fg)]">{repo.fullName}</p>
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            {repo.isPrivate ? "Private" : "Public"} · {repo.isFork ? "Fork" : "Source"} ·{" "}
            {repo.defaultBranch ? `default ${repo.defaultBranch}` : "no default branch"}
          </p>
          {repo.linkKeys.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
              Link keys: <span className="text-[var(--bo-fg)]">{repo.linkKeys.join(", ")}</span>
            </p>
          ) : null}
        </section>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Pull request feed
          </p>
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            Showing open pull requests from GitHub API.
          </p>
          <p className="mt-2 text-[var(--bo-fg)]">
            {pageInfo ? `${pageInfo.perPage} per page` : "Default pagination"}
          </p>
        </section>
      </div>

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Open pull requests
          </p>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {pulls.length} shown
          </span>
        </div>

        {pullsError ? <p className="mt-3 text-sm text-red-500">{pullsError}</p> : null}
        {!pullsError && pulls.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--bo-muted)]">
            No open pull requests for this repo.
          </p>
        ) : null}

        {!pullsError && pulls.length > 0 ? (
          <div className="mt-3 space-y-2">
            {pulls.map((pull, index) => {
              const record = asRecord(pull) ?? {};
              const number = asNumber(record.number);
              const title = asString(record.title) || "(No title)";
              const state = asString(record.state) || "unknown";
              const url = asString(record.html_url);
              const updatedAt = asString(record.updated_at);
              const user = asRecord(record.user);
              const userLogin = asString(user?.login) || "unknown";
              const draft = asBoolean(record.draft);

              return (
                <article
                  key={`${repo.id}-${number ?? index}`}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-[var(--bo-fg)]">
                        #{number ?? "?"} {title}
                      </p>
                      <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                        by {userLogin}
                        {draft ? " · draft" : ""}
                      </p>
                    </div>
                    <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                      {state}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--bo-muted-2)]">
                    <span>Updated {formatTimestamp(updatedAt)}</span>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex text-[var(--bo-accent)] hover:text-[var(--bo-accent-strong)]"
                      >
                        Open on GitHub
                      </a>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
