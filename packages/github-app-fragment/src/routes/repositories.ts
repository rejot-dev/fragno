import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { githubAppFragmentDefinition } from "../github/definition";
import { githubAppSchema } from "../schema";
import {
  normalizeJoinedInstallation,
  normalizeJoinedLinks,
  normalizeLinkKey,
  repoLinkOutputSchema,
  repoSummarySchema,
  repoWithLinksSchema,
  toExternalId,
  type RepoLinkId,
} from "./shared";

export const githubAppRepositoryRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  ({ config, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/repositories/linked",
        queryParameters: ["linkKey"],
        outputSchema: z.array(repoWithLinksSchema),
        handler: async function ({ query }, { json }) {
          const linkKeyFilter = query.get("linkKey")?.trim() ?? null;

          const [repos] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow.find("installation_repo", (b) =>
                b
                  .whereIndex("idx_installation_repo_full_name", (eb) => eb("fullName", "!=", ""))
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

          const output = [];
          for (const repo of repos) {
            if (repo.removedAt !== null) {
              continue;
            }
            const repoId = toExternalId(repo.id);
            if (!repoId) {
              continue;
            }
            const installation = normalizeJoinedInstallation(repo.installation);
            if (installation?.status !== "active") {
              continue;
            }
            const linkEntries = normalizeJoinedLinks(repo.links);
            const linkKeys = linkEntries
              .filter((link) => !linkKeyFilter || link.linkKey === linkKeyFilter)
              .map((link) => link.linkKey);
            if (linkKeys.length === 0) {
              continue;
            }
            output.push({
              id: repoId,
              installationId: toExternalId(installation.id),
              ownerLogin: repo.ownerLogin ?? "",
              name: repo.name ?? "",
              fullName: repo.fullName ?? "",
              isPrivate: Boolean(repo.isPrivate),
              isFork: repo.isFork ?? null,
              defaultBranch: repo.defaultBranch ?? null,
              removedAt: repo.removedAt ?? null,
              updatedAt: repo.updatedAt,
              linkKeys,
            });
          }

          return json(output);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/repositories/link",
        inputSchema: z.object({
          installationId: z.string(),
          repoId: z.string(),
          linkKey: z.string().optional(),
        }),
        outputSchema: z.object({
          link: repoLinkOutputSchema,
          repo: repoSummarySchema,
        }),
        errorCodes: [
          "INSTALLATION_NOT_FOUND",
          "INSTALLATION_INACTIVE",
          "REPO_NOT_FOUND",
          "REPO_REMOVED",
        ],
        handler: async function ({ input }, { json, error }) {
          const values = await input.valid();
          const linkKey = normalizeLinkKey(values.linkKey, config.defaultLinkKey);

          const [installation, repos] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow
                .findFirst("installation", (b) =>
                  b.whereIndex("uniq_installation_id", (eb) =>
                    eb("id", "=", values.installationId),
                  ),
                )
                .find("installation_repo", (b) =>
                  b
                    .whereIndex("idx_installation_repo_installation", (eb) =>
                      eb("installationId", "=", values.installationId),
                    )
                    .joinMany("links", "repo_link", (link) =>
                      link.onIndex("uniq_repo_link_repo_id_link_key", (eb) =>
                        eb("repoId", "=", eb.parent("id")),
                      ),
                    ),
                );
            })
            .execute();

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

          const repo = repos.find((record) => toExternalId(record.id) === values.repoId);
          if (!repo) {
            return error(
              { message: "Repository not found.", code: "REPO_NOT_FOUND" },
              { status: 404 },
            );
          }

          if (repo.removedAt !== null) {
            return error(
              { message: "Repository has been removed.", code: "REPO_REMOVED" },
              { status: 409 },
            );
          }

          const repoOutput = {
            id: values.repoId,
            installationId: values.installationId,
            ownerLogin: repo.ownerLogin ?? "",
            name: repo.name ?? "",
            fullName: repo.fullName ?? "",
            isPrivate: Boolean(repo.isPrivate),
            isFork: repo.isFork ?? null,
            defaultBranch: repo.defaultBranch ?? null,
            removedAt: repo.removedAt ?? null,
            updatedAt: repo.updatedAt,
          };
          const linkEntries = normalizeJoinedLinks(repo.links);
          const existingLink = linkEntries.find((link) => link.linkKey === linkKey);

          if (existingLink) {
            return json({
              link: {
                repoId: values.repoId,
                linkKey: existingLink.linkKey,
                linkedAt: existingLink.linkedAt,
              },
              repo: repoOutput,
            });
          }

          const linkedAt = new Date();
          const link = { repoId: values.repoId, linkKey, linkedAt };
          try {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(githubAppSchema);
                return uow.create("repo_link", {
                  repoId: values.repoId,
                  linkKey,
                  linkedAt,
                });
              })
              .execute();
          } catch (createError) {
            if (!isUniqueConstraintError(createError)) {
              throw createError;
            }
          }

          return json({
            link: {
              repoId: link.repoId,
              linkKey: link.linkKey,
              linkedAt: link.linkedAt,
            },
            repo: repoOutput,
          });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/repositories/unlink",
        inputSchema: z.object({
          repoId: z.string(),
          linkKey: z.string().optional(),
        }),
        outputSchema: z.object({ ok: z.literal(true) }),
        errorCodes: [
          "REPO_NOT_FOUND",
          "INSTALLATION_NOT_FOUND",
          "INSTALLATION_INACTIVE",
          "LINK_NOT_FOUND",
        ],
        handler: async function ({ input }, { json, error }) {
          const values = await input.valid();
          const linkKey = normalizeLinkKey(values.linkKey, config.defaultLinkKey);

          const [repos] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow.find("installation_repo", (b) =>
                b
                  .whereIndex("idx_installation_repo_full_name", (eb) => eb("fullName", "!=", ""))
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

          const repo = repos.find((record) => toExternalId(record.id) === values.repoId);
          if (!repo) {
            return error(
              { message: "Repository not found.", code: "REPO_NOT_FOUND" },
              { status: 404 },
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

          const linkEntries = normalizeJoinedLinks(repo.links);
          const link = linkEntries.find((entry) => entry.linkKey === linkKey);

          if (!link) {
            return error({ message: "Link not found.", code: "LINK_NOT_FOUND" }, { status: 404 });
          }

          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              uow.delete("repo_link", link.id as RepoLinkId);
            })
            .execute();

          return json({ ok: true });
        },
      }),
    ];
  },
);
