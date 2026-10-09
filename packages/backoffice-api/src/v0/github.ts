import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const githubRepositorySchema = z.object({
  id: z.string(),
  installationId: z.string(),
  ownerLogin: z.string(),
  name: z.string(),
  fullName: z.string(),
  isPrivate: z.boolean(),
  defaultBranch: z.string().nullable(),
  linkKeys: z.array(z.string()),
});

export type GitHubRepository = z.infer<typeof githubRepositorySchema>;

export const githubRepositoryAccessTokenSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  repository: z.object({
    id: z.string(),
    fullName: z.string(),
  }),
});

export type GitHubRepositoryAccessToken = z.infer<typeof githubRepositoryAccessTokenSchema>;

const listRepositoriesInputSchema = z.object({
  linkKey: z.string().trim().min(1).optional(),
});

const createRepositoryAccessTokenInputSchema = z.object({
  repoId: z.string().trim().min(1),
  linkKey: z.string().trim().min(1).optional(),
});

export const githubOperations = {
  "github.repositories.list": {
    description: "List GitHub repositories connected to the current organization and their ids.",
    permissions: [BACKOFFICE_PERMISSION.github.read],
    input: listRepositoriesInputSchema,
    output: z.array(githubRepositorySchema),
  },
  "github.repositories.create-access-token": {
    description:
      "Create a repository-scoped, read-only GitHub App installation token for cloning a linked repository. The token expires after one hour.",
    permissions: [BACKOFFICE_PERMISSION.github.read],
    input: createRepositoryAccessTokenInputSchema,
    output: githubRepositoryAccessTokenSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
