import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { githubAppFragmentDefinition } from "../github/definition";
import { githubAppSchema } from "../schema";
import {
  normalizeJoinedInstallation,
  normalizeJoinedLinks,
  normalizeLinkKey,
  toExternalId,
} from "./shared";

export const githubAppRepositoryAccessRoutesFactory = defineRoutes(
  githubAppFragmentDefinition,
).create(({ config, defineRoute, deps }) => [
  defineRoute({
    method: "POST",
    path: "/repositories/access-token",
    inputSchema: z.object({
      repoId: z.string().trim().min(1),
      linkKey: z.string().trim().min(1).optional(),
    }),
    outputSchema: z.object({
      token: z.string().min(1),
      expiresAt: z.string().min(1),
      repository: z.object({
        id: z.string(),
        fullName: z.string(),
      }),
    }),
    errorCodes: [
      "REPO_NOT_FOUND",
      "REPO_REMOVED",
      "REPO_NOT_LINKED",
      "INSTALLATION_NOT_FOUND",
      "INSTALLATION_INACTIVE",
      "GITHUB_API_ERROR",
    ],
    handler: async function ({ input }, { json, error }) {
      const values = await input.valid();
      const linkKey = normalizeLinkKey(values.linkKey, config.defaultLinkKey);

      const [repo] = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(githubAppSchema).findFirst("installation_repo", (builder) =>
            builder
              .whereIndex("primary", (expression) => expression("id", "=", values.repoId))
              .joinOne("installation", "installation", (installation) =>
                installation.onIndex("primary", (expression) =>
                  expression("id", "=", expression.parent("installationId")),
                ),
              )
              .joinMany("links", "repo_link", (link) =>
                link.onIndex("uniq_repo_link_repo_id_link_key", (expression) =>
                  expression("repoId", "=", expression.parent("id")),
                ),
              ),
          ),
        )
        .execute();

      if (!repo) {
        return error({ message: "Repository not found.", code: "REPO_NOT_FOUND" }, { status: 404 });
      }
      if (repo.removedAt !== null) {
        return error(
          { message: "Repository has been removed.", code: "REPO_REMOVED" },
          { status: 409 },
        );
      }
      if (!normalizeJoinedLinks(repo.links).some((link) => link.linkKey === linkKey)) {
        return error(
          { message: "Repository is not linked.", code: "REPO_NOT_LINKED" },
          { status: 403 },
        );
      }

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

      const repositoryId = Number(toExternalId(repo.id));
      const installationId = Number(toExternalId(installation.id));
      if (!Number.isSafeInteger(repositoryId) || !Number.isSafeInteger(installationId)) {
        return error(
          { message: "GitHub repository identity is invalid.", code: "GITHUB_API_ERROR" },
          { status: 502 },
        );
      }

      try {
        const access = await deps.githubApiClient.app.createRepositoryReadToken(
          installationId,
          repositoryId,
        );
        return json({
          ...access,
          repository: { id: values.repoId, fullName: repo.fullName ?? "" },
        });
      } catch (cause) {
        return error(
          {
            message:
              cause instanceof Error ? cause.message : "Failed to create GitHub access token.",
            code: "GITHUB_API_ERROR",
          },
          { status: 502 },
        );
      }
    },
  }),
]);
