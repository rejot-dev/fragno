import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError, type DatabaseRequestContext } from "@fragno-dev/db";

import { githubAppFragmentDefinition } from "../github/definition";
import { githubAppSchema } from "../schema";
import {
  normalizeJoinedInstallation,
  normalizeJoinedLinks,
  normalizeLinkKey,
  toExternalId,
  type RepoLinkId,
} from "./shared";

/** What this store knows about one repository name, for callers that address repositories by name. */
const repositoryAccessSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-installed") }),
  z.object({
    status: z.literal("not-granted"),
    installation: z.object({ id: z.string(), status: z.string() }),
  }),
  z.object({
    status: z.literal("reachable"),
    installation: z.object({ id: z.string(), status: z.string() }),
    repository: z.object({ id: z.string(), linked: z.boolean() }),
  }),
]);

/** Access to one repository name, as reported by `GET /repositories/:owner/:repo`. */
export type GitHubRepositoryAccess = z.output<typeof repositoryAccessSchema>;

const linkKeyInputSchema = z.object({ linkKey: z.string().optional() });

/** Dot segments, including percent-encoded ones, would let a path escape the repository prefix. */
function isRepositoryRelativePath(path: string) {
  if (path === "") {
    return true;
  }
  if (!path.startsWith("/") || /[?#\\]/.test(path)) {
    return false;
  }
  return path
    .split("/")
    .slice(1)
    .every((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return decoded !== "." && decoded !== ".." && !decoded.includes("/");
      } catch {
        return false;
      }
    });
}

const repositoryApiInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .refine(isRepositoryRelativePath, "Path must be relative to the repository, e.g. /issues.")
    .describe("Path under /repos/{owner}/{repo}; empty for the repository itself."),
  query: z.record(z.string(), z.string()),
  body: z.unknown().describe("JSON request body; null sends none."),
  linkKey: z.string().optional(),
});

/** Reads the owner's installations and the repository rows in one round trip. */
async function readRepositoryByName(
  handlerTx: DatabaseRequestContext["handlerTx"],
  { owner, repo, linkKey }: { owner: string; repo: string; linkKey: string },
) {
  const fullName = `${owner}/${repo}`;
  const [installations, repos] = await handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(githubAppSchema)
        .find("installation", (b) =>
          b.whereIndex("idx_installation_account_login", (eb) => eb("accountLogin", "=", owner)),
        )
        .find("installation_repo", (b) =>
          b
            .whereIndex("idx_installation_repo_full_name", (eb) => eb("fullName", "=", fullName))
            .joinOne("installation", "installation", (installation) =>
              installation.onIndex("primary", (eb) => eb("id", "=", eb.parent("installationId"))),
            )
            .joinMany("links", "repo_link", (link) =>
              link.onIndex("uniq_repo_link_repo_id_link_key", (eb) =>
                eb("repoId", "=", eb.parent("id")),
              ),
            ),
        ),
    )
    .execute();

  // A name can have rows from earlier installations or removals; only a current row is reachable.
  const current = repos.flatMap((row) => {
    const installation = normalizeJoinedInstallation(row.installation);
    return row.removedAt === null && installation && installation.status !== "deleted"
      ? [{ row, installation }]
      : [];
  });
  const linkedRow = current.find(({ row }) =>
    normalizeJoinedLinks(row.links).some((link) => link.linkKey === linkKey),
  );
  const reachable = linkedRow ?? current[0];
  const ownerInstallation =
    installations.find((installation) => installation.status === "active") ??
    installations.find((installation) => installation.status !== "deleted");

  const access: GitHubRepositoryAccess = reachable
    ? {
        status: "reachable",
        installation: {
          id: toExternalId(reachable.installation.id),
          status: reachable.installation.status,
        },
        repository: { id: toExternalId(reachable.row.id), linked: linkedRow !== undefined },
      }
    : ownerInstallation
      ? {
          status: "not-granted",
          installation: {
            id: toExternalId(ownerInstallation.id),
            status: ownerInstallation.status,
          },
        }
      : { status: "not-installed" };
  return {
    access,
    linked: linkedRow && {
      repositoryId: toExternalId(linkedRow.row.id),
      // linkedRow was selected because it has a link with this key.
      link: normalizeJoinedLinks(linkedRow.row.links).find((link) => link.linkKey === linkKey)!,
    },
  };
}

export const githubAppRepositoryByNameRoutesFactory = defineRoutes(
  githubAppFragmentDefinition,
).create(({ config, defineRoute, deps }) => [
  defineRoute({
    method: "GET",
    path: "/repositories/:owner/:repo",
    queryParameters: ["linkKey"],
    outputSchema: repositoryAccessSchema,
    handler: async function ({ pathParams, query }, { json }) {
      const { access } = await readRepositoryByName(this.handlerTx.bind(this), {
        ...pathParams,
        linkKey: normalizeLinkKey(query.get("linkKey"), config.defaultLinkKey),
      });
      return json(access);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/repositories/:owner/:repo/link",
    inputSchema: linkKeyInputSchema,
    outputSchema: z.object({ repoId: z.string(), linkKey: z.string() }),
    errorCodes: ["REPO_NOT_REACHABLE", "INSTALLATION_INACTIVE"],
    handler: async function ({ pathParams, input }, { json, error }) {
      const values = await input.valid();
      const linkKey = normalizeLinkKey(values.linkKey, config.defaultLinkKey);
      const { access } = await readRepositoryByName(this.handlerTx.bind(this), {
        ...pathParams,
        linkKey,
      });
      if (access.status !== "reachable") {
        return error(
          { message: "The GitHub App cannot reach this repository.", code: "REPO_NOT_REACHABLE" },
          { status: 404 },
        );
      }
      if (access.installation.status !== "active") {
        return error(
          { message: "Installation is not active.", code: "INSTALLATION_INACTIVE" },
          { status: 409 },
        );
      }
      const repoId = access.repository.id;
      if (!access.repository.linked) {
        try {
          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              uow.create("repo_link", { repoId, linkKey });
              uow.triggerHook("onRepositoryLinkStatusChanged", {
                linkKey,
                repositoryId: repoId,
                fullName: `${pathParams.owner}/${pathParams.repo}`,
                status: "active",
              });
            })
            .execute();
        } catch (createError) {
          if (!isUniqueConstraintError(createError)) {
            throw createError;
          }
        }
      }
      return json({ repoId, linkKey });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/repositories/:owner/:repo/unlink",
    inputSchema: linkKeyInputSchema,
    outputSchema: z.object({ status: z.enum(["unlinked", "not-linked"]) }),
    handler: async function ({ pathParams, input }, { json }) {
      const values = await input.valid();
      const linkKey = normalizeLinkKey(values.linkKey, config.defaultLinkKey);
      const { linked } = await readRepositoryByName(this.handlerTx.bind(this), {
        ...pathParams,
        linkKey,
      });
      if (linked === undefined) {
        return json({ status: "not-linked" });
      }
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(githubAppSchema);
          uow.delete("repo_link", linked.link.id as RepoLinkId);
          uow.triggerHook("onRepositoryLinkStatusChanged", {
            linkKey,
            repositoryId: linked.repositoryId,
            fullName: `${pathParams.owner}/${pathParams.repo}`,
            status: "unlinked",
          });
        })
        .execute();
      return json({ status: "unlinked" });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/repositories/:owner/:repo/api",
    inputSchema: repositoryApiInputSchema,
    outputSchema: z.object({
      status: z.number(),
      headers: z.record(z.string(), z.string()),
      body: z.unknown(),
    }),
    errorCodes: [
      "REPO_NOT_REACHABLE",
      "REPO_NOT_LINKED",
      "INSTALLATION_INACTIVE",
      "GITHUB_API_ERROR",
    ],
    handler: async function ({ pathParams, input }, { json, error }) {
      const values = await input.valid();
      const linkKey = normalizeLinkKey(values.linkKey, config.defaultLinkKey);
      const { access } = await readRepositoryByName(this.handlerTx.bind(this), {
        ...pathParams,
        linkKey,
      });
      if (access.status !== "reachable") {
        return error(
          { message: "The GitHub App cannot reach this repository.", code: "REPO_NOT_REACHABLE" },
          { status: 404 },
        );
      }
      if (!access.repository.linked) {
        return error(
          { message: "Repository is not linked.", code: "REPO_NOT_LINKED" },
          { status: 403 },
        );
      }
      if (access.installation.status !== "active") {
        return error(
          { message: "Installation is not active.", code: "INSTALLATION_INACTIVE" },
          { status: 409 },
        );
      }
      const search = new URLSearchParams(values.query).toString();
      const url = `/repos/${encodeURIComponent(pathParams.owner)}/${encodeURIComponent(pathParams.repo)}${values.path}${search ? `?${search}` : ""}`;
      try {
        return json(
          await deps.githubApiClient.app.requestAsRepository(
            Number(access.installation.id),
            Number(access.repository.id),
            { method: values.method, url, body: values.body ?? null },
          ),
        );
      } catch (cause) {
        return error(
          {
            message: cause instanceof Error ? cause.message : "GitHub API request failed.",
            code: "GITHUB_API_ERROR",
          },
          { status: 502 },
        );
      }
    },
  }),
]);
