import type { TableToColumnValues } from "@fragno-dev/db/query";
import { FragnoId } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import type { GitHubInstallationDetails, GitHubInstallationRepository } from "./github/api";
import { githubAppFragmentDefinition } from "./github/definition";
import { hasRepoChanges, toRepoCreateRecord, toRepoRecord } from "./github/repo-sync";
import {
  isRecord,
  normalizeJoinedInstallation,
  normalizeJoinedLinks,
  toExternalId,
  toStringValue,
} from "./github/utils";
import type { WebhookProcessingPayload } from "./github/webhook-processing";
import { githubAppSchema } from "./schema";

type InstallationRepoRow = TableToColumnValues<
  (typeof githubAppSchema)["tables"]["installation_repo"]
>;
type RepoLinkRow = TableToColumnValues<(typeof githubAppSchema)["tables"]["repo_link"]>;
type RepoId = string | FragnoId;
type RepoLinkId = string | FragnoId;

const toDebugSignature = (signatureHeader: string | null) => {
  if (!signatureHeader) {
    return null;
  }
  if (signatureHeader.length <= 20) {
    return signatureHeader;
  }
  return `${signatureHeader.slice(0, 12)}…${signatureHeader.slice(-8)}`;
};

const normalizeLinkKey = (linkKey: string | null | undefined, defaultLinkKey?: string) => {
  const normalized = linkKey?.trim();
  return normalized && normalized.length > 0 ? normalized : (defaultLinkKey ?? "default");
};

const parseLinkedOnly = (value: string | null) => value === "true" || value === "1";

const getHttpStatusCode = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "object" && value && "status" in value) {
    const status = (value as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
  }
  return null;
};

const installationOutputSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  status: z.string(),
  permissions: z.any(),
  events: z.any(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastWebhookAt: z.date().nullable(),
});

const repoSummarySchema = z.object({
  id: z.string(),
  installationId: z.string(),
  ownerLogin: z.string(),
  name: z.string(),
  fullName: z.string(),
  isPrivate: z.boolean(),
  isFork: z.boolean().nullable(),
  defaultBranch: z.string().nullable(),
  removedAt: z.date().nullable(),
  updatedAt: z.date(),
});

const repoWithLinksSchema = repoSummarySchema.extend({
  linkKeys: z.array(z.string()),
});

const repoLinkOutputSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  linkKey: z.string(),
  linkedAt: z.date(),
});

export const githubAppRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  ({ config, defineRoute, deps }) => {
    const api = deps.githubApiClient;

    return [
      defineRoute({
        method: "POST",
        path: "/webhooks",
        errorCodes: [
          "WEBHOOK_SIGNATURE_INVALID",
          "WEBHOOK_DELIVERY_MISSING",
          "WEBHOOK_PAYLOAD_INVALID",
        ],
        handler: async function (ctx, { empty, error }) {
          const rawBody = ctx.rawBody;
          const logWebhook =
            config.webhookDebug === true
              ? (message: string, details?: Record<string, unknown>) => {
                  if (details) {
                    console.log("[github-app-fragment webhook]", message, details);
                  } else {
                    console.log("[github-app-fragment webhook]", message);
                  }
                }
              : undefined;

          logWebhook?.("received", {
            hasRawBody: Boolean(rawBody),
            rawBodyBytes: rawBody ? Buffer.byteLength(rawBody, "utf8") : 0,
            signature: toDebugSignature(ctx.headers.get("x-hub-signature-256")),
            deliveryId: ctx.headers.get("x-github-delivery") ?? null,
            event: ctx.headers.get("x-github-event") ?? null,
            contentType: ctx.headers.get("content-type") ?? null,
          });

          if (!rawBody) {
            logWebhook?.("rejected: missing payload");
            return error(
              { message: "Missing webhook payload.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          const signatureHeader = ctx.headers.get("x-hub-signature-256");
          const signatureOk = await api.verifyWebhookSignature({
            payload: rawBody,
            signatureHeader,
          });
          logWebhook?.("signature check", { ok: signatureOk });
          if (!signatureOk) {
            logWebhook?.("rejected: invalid signature");
            return error(
              { message: "Invalid webhook signature.", code: "WEBHOOK_SIGNATURE_INVALID" },
              { status: 401 },
            );
          }

          const deliveryId = ctx.headers.get("x-github-delivery") ?? "";
          if (!deliveryId) {
            logWebhook?.("rejected: missing delivery id");
            return error(
              { message: "Missing delivery id.", code: "WEBHOOK_DELIVERY_MISSING" },
              { status: 400 },
            );
          }

          const event = ctx.headers.get("x-github-event") ?? "";
          if (!event) {
            logWebhook?.("rejected: missing event");
            return error(
              { message: "Missing webhook event type.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          let payload: unknown;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            logWebhook?.("rejected: invalid json");
            return error(
              { message: "Invalid JSON payload.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          if (!isRecord(payload)) {
            logWebhook?.("rejected: payload not object");
            return error(
              { message: "Invalid webhook payload.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          const action =
            typeof payload["action"] === "string" ? (payload["action"] as string) : null;
          const installationPayload = isRecord(payload["installation"])
            ? payload["installation"]
            : null;

          const installationId = toStringValue(
            installationPayload?.["id"] ?? payload["installation_id"],
          );
          if (!installationId) {
            logWebhook?.("rejected: missing installation id");
            return error(
              { message: "Missing installation id.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          const now = new Date();
          logWebhook?.("accepted", {
            deliveryId,
            event,
            action,
            installationId,
          });
          const webhookPayload: WebhookProcessingPayload = {
            deliveryId,
            event,
            action,
            installationId,
            payload,
            receivedAt: now.toISOString(),
          };

          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              uow.triggerHook("processWebhook", webhookPayload);
            })
            .execute();

          return empty(204);
        },
      }),
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
            if (!installation || installation.status !== "active") {
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

          const linkEntries = normalizeJoinedLinks(repo.links);
          const existingLink = linkEntries.find((link) => link.linkKey === linkKey);

          if (existingLink) {
            return json({
              link: {
                id: toExternalId(existingLink.id),
                repoId: values.repoId,
                linkKey: existingLink.linkKey,
                linkedAt: existingLink.linkedAt,
              },
              repo: {
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
              },
            });
          }

          const linkedAt = new Date();
          const linkId = await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow.create("repo_link", {
                repoId: values.repoId,
                linkKey,
                linkedAt,
              });
            })
            .execute();

          return json({
            link: {
              id: toExternalId(linkId),
              repoId: values.repoId,
              linkKey,
              linkedAt,
            },
            repo: {
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
            },
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

          const repo = repos[0];
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

          const repo = repos[0];
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
          const installationId = pathParams.installationId;
          let bootstrapInstallation: GitHubInstallationDetails | null = null;

          const [existingInstallation, existingRepos] = await this.handlerTx()
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

          if (!existingInstallation) {
            try {
              bootstrapInstallation = await api.getInstallation(installationId);
            } catch (err) {
              if (getHttpStatusCode(err) === 404) {
                return error(
                  { message: "Installation not found.", code: "INSTALLATION_NOT_FOUND" },
                  { status: 404 },
                );
              }
              const message = err instanceof Error ? err.message : "GitHub API request failed.";
              return error({ message, code: "GITHUB_API_ERROR" }, { status: 502 });
            }
          }

          let response: { repositories: GitHubInstallationRepository[] };
          try {
            response = await api.listInstallationRepos(installationId);
          } catch (err) {
            const message = err instanceof Error ? err.message : "GitHub API request failed.";
            return error({ message, code: "GITHUB_API_ERROR" }, { status: 502 });
          }

          const repos = response.repositories ?? [];
          const now = new Date();

          const existingById = new Map<string, InstallationRepoRow>();
          for (const repo of existingRepos) {
            const id = toExternalId(repo.id);
            if (id) {
              existingById.set(id, repo);
            }
          }

          const repoLinksByRepoId = new Map<string, RepoLinkRow[]>();
          for (const repo of existingRepos) {
            const repoId = toExternalId(repo.id);
            if (!repoId) {
              continue;
            }
            const linkEntries = normalizeJoinedLinks(repo.links);
            if (linkEntries.length === 0) {
              continue;
            }
            repoLinksByRepoId.set(repoId, linkEntries);
          }

          let added = 0;
          let updated = 0;
          let removed = 0;

          type RepoUpdateData = Omit<ReturnType<typeof toRepoRecord>, "id">;
          const creates: Array<ReturnType<typeof toRepoRecord>> = [];
          const updates: Array<{ id: RepoId; data: Partial<RepoUpdateData> }> = [];
          const removals: Array<RepoId> = [];
          const linksToDelete: Array<RepoLinkId> = [];

          const seen = new Set<string>();

          for (const repo of repos) {
            const record = toRepoRecord(installationId, repo, now);
            seen.add(record.id);
            const existing = existingById.get(record.id);

            if (!existing) {
              added += 1;
              creates.push(record);
              continue;
            }

            if (hasRepoChanges(existing, record)) {
              updated += 1;
              updates.push({
                id: existing.id as RepoId,
                data: {
                  installationId: record.installationId,
                  ownerLogin: record.ownerLogin,
                  name: record.name,
                  fullName: record.fullName,
                  isPrivate: record.isPrivate,
                  ...(record.isFork !== undefined ? { isFork: record.isFork } : {}),
                  ...(record.defaultBranch !== undefined
                    ? { defaultBranch: record.defaultBranch }
                    : {}),
                  removedAt: null,
                  updatedAt: now,
                },
              });
            }
          }

          for (const [repoId, repo] of existingById.entries()) {
            if (seen.has(repoId)) {
              continue;
            }
            if (repo.removedAt === null) {
              removed += 1;
              removals.push(repo.id as RepoId);
              const links = repoLinksByRepoId.get(repoId);
              if (links) {
                for (const link of links) {
                  linksToDelete.push(link.id as RepoLinkId);
                }
              }
            }
          }

          if (
            bootstrapInstallation ||
            creates.length > 0 ||
            updates.length > 0 ||
            removals.length > 0 ||
            linksToDelete.length > 0
          ) {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(githubAppSchema);

                if (bootstrapInstallation) {
                  uow.create("installation", {
                    id: bootstrapInstallation.id,
                    accountId: bootstrapInstallation.accountId,
                    accountLogin: bootstrapInstallation.accountLogin,
                    accountType: bootstrapInstallation.accountType,
                    status: bootstrapInstallation.status,
                    permissions: bootstrapInstallation.permissions,
                    events: bootstrapInstallation.events,
                  });
                }

                for (const record of creates) {
                  uow.create("installation_repo", toRepoCreateRecord(record));
                }

                for (const update of updates) {
                  uow.update("installation_repo", update.id, (b) => b.set(update.data));
                }

                for (const id of removals) {
                  uow.update("installation_repo", id, (b) =>
                    b.set({ removedAt: now, updatedAt: now }),
                  );
                }

                for (const id of linksToDelete) {
                  uow.delete("repo_link", id);
                }
              })
              .execute();
          }

          return json({ added, removed, updated });
        },
      }),
    ];
  },
);
