import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { githubAppFragmentDefinition } from "../github/definition";
import { githubAppSchema } from "../schema";
import {
  installationOutputSchema,
  normalizeJoinedLinks,
  parseLinkedOnly,
  repoWithLinksSchema,
  syncInstallationFromGitHub,
  toExternalId,
} from "./shared";

export const githubAppInstallationRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  ({ defineRoute, deps, services }) => {
    const api = deps.githubApiClient;

    return [
      defineRoute({
        method: "GET",
        path: "/installations",
        queryParameters: ["status"],
        outputSchema: z.array(installationOutputSchema),
        errorCodes: ["INVALID_STATUS"],
        handler: async function ({ query }, { json, error }) {
          const status = query.get("status");
          if (status && !["active", "suspended", "deleted"].includes(status)) {
            return error(
              { message: `Invalid status: ${status}`, code: "INVALID_STATUS" },
              { status: 400 },
            );
          }

          const [installations] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              if (status) {
                return uow.find("installation", (b) =>
                  b.whereIndex("idx_installation_status", (eb) => eb("status", "=", status)),
                );
              }
              return uow.find("installation", (b) =>
                b.whereIndex("idx_installation_status", (eb) => eb("status", "!=", "")),
              );
            })
            .execute();

          return json(
            installations.map((installation) => ({
              id: toExternalId(installation.id),
              accountId: installation.accountId,
              accountLogin: installation.accountLogin,
              accountType: installation.accountType,
              status: installation.status,
              permissions: installation.permissions,
              events: installation.events,
              createdAt: installation.createdAt,
              updatedAt: installation.updatedAt,
              lastWebhookAt: installation.lastWebhookAt,
            })),
          );
        },
      }),
      defineRoute({
        method: "GET",
        path: "/installations/:installationId/repos",
        queryParameters: ["linkedOnly", "linkKey"],
        outputSchema: z.array(repoWithLinksSchema),
        errorCodes: ["INSTALLATION_NOT_FOUND"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const installationId = pathParams.installationId;
          const linkedOnly = parseLinkedOnly(query.get("linkedOnly"));
          const linkKeyFilter = query.get("linkKey")?.trim() ?? null;

          const [installation, repos] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow
                .findFirst("installation", (b) =>
                  b.whereIndex("uniq_installation_id", (eb) => eb("id", "=", installationId)),
                )
                .find("installation_repo", (b) =>
                  b
                    .whereIndex("idx_installation_repo_installation", (eb) =>
                      eb("installationId", "=", installationId),
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

          const output = [];
          for (const repo of repos) {
            if (repo.removedAt !== null) {
              continue;
            }
            const repoId = toExternalId(repo.id);
            if (!repoId) {
              continue;
            }
            const linkEntries = normalizeJoinedLinks(repo.links);
            const linkKeys = linkEntries
              .filter((link) => !linkKeyFilter || link.linkKey === linkKeyFilter)
              .map((link) => link.linkKey);
            if (linkedOnly && linkKeys.length === 0) {
              continue;
            }
            output.push({
              id: repoId,
              installationId,
              ownerLogin: repo.ownerLogin ?? "",
              name: repo.name ?? "",
              fullName: repo.fullName ?? "",
              isPrivate: repo.isPrivate,
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
        path: "/installations/:installationId/sync",
        outputSchema: z.object({
          added: z.number(),
          removed: z.number(),
          updated: z.number(),
        }),
        errorCodes: ["GITHUB_API_ERROR", "INSTALLATION_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const syncResult = await syncInstallationFromGitHub(
            this.handlerTx,
            services,
            api,
            pathParams.installationId,
          );
          if (!syncResult.ok) {
            return error(
              { message: syncResult.message, code: syncResult.code },
              { status: syncResult.status === 404 ? 404 : 502 },
            );
          }

          return json(syncResult.result);
        },
      }),
    ];
  },
);
