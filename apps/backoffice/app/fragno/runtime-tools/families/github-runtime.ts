import {
  type GitHubRepository,
  type GitHubRepositoryAccessToken,
  githubRepositoryAccessTokenSchema,
  githubRepositorySchema,
} from "@fragno-dev/backoffice-api/v0/github";
import { createRouteCaller } from "@fragno-dev/core/api";
import { z } from "zod";

import type { FetchObject } from "@/backoffice-runtime/object-registry";
import type { GitHubFragment } from "@/fragno/github";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

export type GitHubRuntime = {
  listRepositories(input?: { linkKey?: string }): Promise<GitHubRepository[]>;
  createRepositoryAccessToken(input: {
    repoId: string;
    linkKey?: string;
  }): Promise<GitHubRepositoryAccessToken>;
};

export function createGitHubRuntime(object: FetchObject): GitHubRuntime {
  const callRoute = createRouteCaller<GitHubFragment>({
    baseUrl: "https://github.do",
    mountRoute: "/api/github",
    fetch: object.fetch.bind(object),
  });

  return {
    async listRepositories(input = {}) {
      const response = await callRoute("GET", "/repositories/linked", {
        query: input.linkKey ? { linkKey: input.linkKey } : {},
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return z.array(githubRepositorySchema).parse(response.data);
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "GitHub fragment",
        label: "github.repositories.list",
        notConfiguredMessage: "GitHub is not configured for this organization.",
      });
    },
    async createRepositoryAccessToken(input) {
      const response = await callRoute("POST", "/repositories/access-token", { body: input });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return githubRepositoryAccessTokenSchema.parse(response.data);
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "GitHub fragment",
        label: "github.repositories.createAccessToken",
        notConfiguredMessage: "GitHub is not configured for this organization.",
      });
    },
  };
}
