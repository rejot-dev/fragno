import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { githubAppFragmentDefinition } from "../github/definition";
import { githubAppSchema } from "../schema";
import {
  createOAuthState,
  oauthCompleteOutputSchema,
  oauthStartOutputSchema,
  OAUTH_STATE_TTL_MS,
  toOAuthInstallation,
} from "./shared";

export const githubAppOAuthRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  ({ config, defineRoute, deps }) => {
    const api = deps.githubApiClient;

    return [
      defineRoute({
        method: "POST",
        path: "/oauth/start",
        inputSchema: z.object({
          subjectId: z.string().trim().min(1),
          returnTo: z.string().optional(),
        }),
        outputSchema: oauthStartOutputSchema,
        handler: async function ({ input }, { json }) {
          const values = await input.valid();
          const state = createOAuthState();
          const now = new Date();
          const expiresAt = new Date(
            now.getTime() + (config.userAuthorizationStateTtlMs ?? OAUTH_STATE_TTL_MS),
          );

          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              uow.create("oauth_state", {
                id: state,
                subjectId: values.subjectId,
                returnTo: values.returnTo?.trim() || null,
                installations: null,
                githubUserId: null,
                githubLogin: null,
                expiresAt,
                completedAt: null,
              });
            })
            .execute();

          return json({
            authorizationUrl: api.createUserAuthorizationUrl({ state }),
            state,
            expiresAt,
          });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/oauth/complete",
        inputSchema: z.object({
          subjectId: z.string().trim().min(1),
          state: z.string().min(1),
          code: z.string().min(1),
        }),
        outputSchema: oauthCompleteOutputSchema,
        errorCodes: [
          "OAUTH_STATE_NOT_FOUND",
          "OAUTH_STATE_EXPIRED",
          "OAUTH_STATE_COMPLETED",
          "SUBJECT_MISMATCH",
          "GITHUB_API_ERROR",
        ],
        handler: async function ({ input }, { json, error }) {
          const values = await input.valid();
          const [oauthState] = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              return uow.findFirst("oauth_state", (b) =>
                b.whereIndex("uniq_oauth_state", (eb) => eb("id", "=", values.state)),
              );
            })
            .execute();

          if (!oauthState) {
            return error(
              { message: "OAuth state was not found.", code: "OAUTH_STATE_NOT_FOUND" },
              { status: 404 },
            );
          }
          if (oauthState.expiresAt <= new Date()) {
            return error(
              { message: "OAuth state expired.", code: "OAUTH_STATE_EXPIRED" },
              { status: 400 },
            );
          }
          if (oauthState.completedAt) {
            return error(
              { message: "OAuth state was already completed.", code: "OAUTH_STATE_COMPLETED" },
              { status: 400 },
            );
          }
          if (oauthState.subjectId !== values.subjectId) {
            return error(
              {
                message: "OAuth state belongs to a different subject.",
                code: "SUBJECT_MISMATCH",
              },
              { status: 403 },
            );
          }

          let githubUser;
          let installations;
          try {
            const token = await api.exchangeUserAuthorizationCode({
              code: values.code,
              state: values.state,
            });
            githubUser = await api.getUserProfile(token.accessToken);
            const response = await api.listUserInstallations(token.accessToken);
            installations = response.installations.flatMap((installation) =>
              installation.appId === config.appId || installation.appSlug === config.appSlug
                ? [toOAuthInstallation(installation)]
                : [],
            );
          } catch (err) {
            return error(
              {
                message: err instanceof Error ? err.message : "GitHub API request failed.",
                code: "GITHUB_API_ERROR",
              },
              { status: 502 },
            );
          }

          const completedAt = new Date();
          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(githubAppSchema);
              uow.update("oauth_state", oauthState.id, (b) =>
                b
                  .set({
                    installations,
                    githubUserId: githubUser.id,
                    githubLogin: githubUser.login,
                    completedAt,
                  })
                  .check(),
              );
            })
            .execute();

          return json({
            state: values.state,
            subjectId: oauthState.subjectId,
            githubUser,
            installations,
            returnTo: oauthState.returnTo ?? null,
            expiresAt: oauthState.expiresAt,
          });
        },
      }),
    ];
  },
);
