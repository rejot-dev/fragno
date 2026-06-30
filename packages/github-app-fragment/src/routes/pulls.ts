import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { githubAppFragmentDefinition } from "../github/definition";
import { githubAppSchema } from "../schema";
import { normalizeJoinedInstallation, normalizeJoinedLinks, toExternalId } from "./shared";

type PullRouteRepoCandidate = {
  removedAt: Date | null;
  links: { linkKey?: string | null } | { linkKey?: string | null }[] | null | undefined;
};

type PullRouteRepoResolution<TRepo> =
  | { status: "found"; repo: TRepo }
  | { status: "missing" }
  | { status: "removed" };

const resolveCurrentPullRouteRepo = <TRepo extends PullRouteRepoCandidate>(
  repos: readonly TRepo[],
): PullRouteRepoResolution<TRepo> => {
  if (repos.length === 0) {
    return { status: "missing" };
  }

  const activeRepos = repos.filter((repo) => repo.removedAt === null);
  const repo = activeRepos.find((candidate) => normalizeJoinedLinks(candidate.links).length > 0);
  if (repo) {
    return { status: "found", repo };
  }

  if (activeRepos[0]) {
    return { status: "found", repo: activeRepos[0] };
  }

  return { status: "removed" };
};

export const githubAppPullRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  ({ defineRoute, deps }) => {
    const api = deps.githubApiClient;

    return [
      defineRoute({
        method: "GET",
        path: "/repositories/:owner/:repo/pulls",
        queryParameters: ["state", "perPage", "page"],
        outputSchema: z.object({
          pulls: z.array(z.any()),
          pageInfo: z.object({
            page: z.number(),
            perPage: z.number(),
          }),
        }),
        errorCodes: [
          "INVALID_STATE",
          "INVALID_PER_PAGE",
          "INVALID_PAGE",
          "REPO_NOT_FOUND",
          "REPO_REMOVED",
          "REPO_NOT_LINKED",
          "INSTALLATION_NOT_FOUND",
          "INSTALLATION_INACTIVE",
          "GITHUB_API_ERROR",
        ],
        handler: async function ({ pathParams, query }, { json, error }) {
          const state = query.get("state");
          if (state && !["open", "closed", "all"].includes(state)) {
            return error(
              { message: `Invalid state: ${state}`, code: "INVALID_STATE" },
              { status: 400 },
            );
          }
          const stateFilter = (state ?? undefined) as "open" | "closed" | "all" | undefined;

          const perPageRaw = query.get("perPage");
          const perPage = perPageRaw ? Number.parseInt(perPageRaw, 10) : 30;
          if (!Number.isFinite(perPage) || perPage <= 0 || perPage > 100) {
            return error(
              { message: "perPage must be between 1 and 100.", code: "INVALID_PER_PAGE" },
              { status: 400 },
            );
          }

          const pageRaw = query.get("page");
          const page = pageRaw ? Number.parseInt(pageRaw, 10) : 1;
          if (!Number.isFinite(page) || page <= 0) {
            return error(
              { message: "page must be a positive number.", code: "INVALID_PAGE" },
              { status: 400 },
            );
          }

          const fullName = `${pathParams.owner}/${pathParams.repo}`;
          const [repos] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow.find("installation_repo", (b) =>
                b
                  .whereIndex("idx_installation_repo_full_name", (eb) =>
                    eb("fullName", "=", fullName),
                  )
                  .joinOne("installation", "installation", (installation) =>
                    installation.onIndex("primary", (eb) =>
                      eb("id", "=", eb.parent("installationId")),
                    ),
                  )
                  .joinMany("links", "repo_link", (link) =>
                    link.onIndex("uniq_repo_link_repo_id_link_key", (eb) =>
                      eb("repoId", "=", eb.parent("id")),
                    ),
                  ),
              );
            })
            .execute();

          const resolvedRepo = resolveCurrentPullRouteRepo(repos);
          if (resolvedRepo.status === "missing") {
            return error(
              { message: "Repository not found.", code: "REPO_NOT_FOUND" },
              { status: 404 },
            );
          }

          if (resolvedRepo.status === "removed") {
            return error(
              { message: "Repository has been removed.", code: "REPO_REMOVED" },
              { status: 409 },
            );
          }

          const { repo } = resolvedRepo;

          const installation = normalizeJoinedInstallation(repo.installation);

          if (!installation) {
            return error(
              { message: "Installation not found.", code: "INSTALLATION_NOT_FOUND" },
              { status: 404 },
            );
          }

          if (installation.status !== "active") {
            return error(
              { message: "Installation is not active.", code: "INSTALLATION_INACTIVE" },
              { status: 409 },
            );
          }

          const installationId = toExternalId(installation.id);

          const linkEntries = normalizeJoinedLinks(repo.links);
          const linked = linkEntries.length > 0;

          if (!linked) {
            return error(
              { message: "Repository is not linked.", code: "REPO_NOT_LINKED" },
              { status: 403 },
            );
          }

          let pulls: unknown[];
          try {
            const installationOctokit = await api.app.getInstallationOctokit(
              api.resolveInstallationId(installationId),
            );
            const response = await installationOctokit.request("GET /repos/{owner}/{repo}/pulls", {
              owner: pathParams.owner,
              repo: pathParams.repo,
              state: stateFilter,
              per_page: perPage,
              page,
            });
            pulls = response.data;
          } catch (err) {
            const message = err instanceof Error ? err.message : "GitHub API request failed.";
            return error({ message, code: "GITHUB_API_ERROR" }, { status: 502 });
          }

          return json({ pulls, pageInfo: { page, perPage } });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/repositories/:owner/:repo/pulls/:number/reviews",
        inputSchema: z.object({
          event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
          body: z.string().optional(),
          comments: z.array(z.any()).optional(),
          commitId: z.string().optional(),
        }),
        outputSchema: z.object({ review: z.any() }),
        errorCodes: [
          "INVALID_PULL_NUMBER",
          "REPO_NOT_FOUND",
          "REPO_REMOVED",
          "REPO_NOT_LINKED",
          "INSTALLATION_NOT_FOUND",
          "INSTALLATION_INACTIVE",
          "GITHUB_API_ERROR",
        ],
        handler: async function ({ pathParams, input }, { json, error }) {
          const values = await input.valid();
          const pullNumber = Number.parseInt(pathParams.number, 10);
          if (!Number.isFinite(pullNumber) || pullNumber <= 0) {
            return error(
              { message: "Invalid pull request number.", code: "INVALID_PULL_NUMBER" },
              { status: 400 },
            );
          }

          const fullName = `${pathParams.owner}/${pathParams.repo}`;
          const [repos] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow.find("installation_repo", (b) =>
                b
                  .whereIndex("idx_installation_repo_full_name", (eb) =>
                    eb("fullName", "=", fullName),
                  )
                  .joinOne("installation", "installation", (installation) =>
                    installation.onIndex("primary", (eb) =>
                      eb("id", "=", eb.parent("installationId")),
                    ),
                  )
                  .joinMany("links", "repo_link", (link) =>
                    link.onIndex("uniq_repo_link_repo_id_link_key", (eb) =>
                      eb("repoId", "=", eb.parent("id")),
                    ),
                  ),
              );
            })
            .execute();

          const resolvedRepo = resolveCurrentPullRouteRepo(repos);
          if (resolvedRepo.status === "missing") {
            return error(
              { message: "Repository not found.", code: "REPO_NOT_FOUND" },
              { status: 404 },
            );
          }

          if (resolvedRepo.status === "removed") {
            return error(
              { message: "Repository has been removed.", code: "REPO_REMOVED" },
              { status: 409 },
            );
          }

          const { repo } = resolvedRepo;

          const installation = normalizeJoinedInstallation(repo.installation);

          if (!installation) {
            return error(
              { message: "Installation not found.", code: "INSTALLATION_NOT_FOUND" },
              { status: 404 },
            );
          }

          if (installation.status !== "active") {
            return error(
              { message: "Installation is not active.", code: "INSTALLATION_INACTIVE" },
              { status: 409 },
            );
          }

          const installationId = toExternalId(installation.id);

          const linkEntries = normalizeJoinedLinks(repo.links);
          const linked = linkEntries.length > 0;

          if (!linked) {
            return error(
              { message: "Repository is not linked.", code: "REPO_NOT_LINKED" },
              { status: 403 },
            );
          }

          let review: unknown;
          try {
            const installationOctokit = await api.app.getInstallationOctokit(
              api.resolveInstallationId(installationId),
            );
            const response = await installationOctokit.request(
              "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
              {
                owner: pathParams.owner,
                repo: pathParams.repo,
                pull_number: pullNumber,
                event: values.event,
                body: values.body,
                comments: values.comments,
                commit_id: values.commitId,
              },
            );
            review = response.data;
          } catch (err) {
            const message = err instanceof Error ? err.message : "GitHub API request failed.";
            return error({ message, code: "GITHUB_API_ERROR" }, { status: 502 });
          }

          return json({ review });
        },
      }),
    ];
  },
);
