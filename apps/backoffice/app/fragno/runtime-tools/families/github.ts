import { z } from "zod";

import {
  defineCliArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import {
  githubRepositoryAccessTokenSchema,
  githubRepositorySchema,
  type GitHubRepository,
  type GitHubRuntime,
} from "./github-runtime";

export type { GitHubRuntime } from "./github-runtime";

type GitHubToolContext = BackofficeToolContext<{ github?: GitHubRuntime }>;

const listRepositoriesInputSchema = z.object({
  linkKey: z.string().trim().min(1).optional(),
});

const createRepositoryAccessTokenInputSchema = z.object({
  repoId: z.string().trim().min(1),
  linkKey: z.string().trim().min(1).optional(),
});

const getGitHubRuntime = (runtime: GitHubToolContext["runtimes"]["github"]): GitHubRuntime => {
  if (!runtime) {
    throw new Error("GitHub runtime is not available in this execution context");
  }
  return runtime;
};

const formatRepositoriesTable = (repositories: GitHubRepository[]) => {
  if (repositories.length === 0) {
    return "No linked GitHub repositories.\n";
  }

  const rows = repositories.map((repository) => [
    repository.id,
    repository.fullName,
    repository.isPrivate ? "private" : "public",
    repository.defaultBranch ?? "-",
    repository.linkKeys.join(","),
  ]);
  const headers = ["ID", "REPOSITORY", "VISIBILITY", "DEFAULT BRANCH", "LINK KEYS"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return `${[headers, ...rows]
    .map((row) =>
      row
        .map((value, index) =>
          index === row.length - 1 ? value : value.padEnd(widths[index] ?? 0),
        )
        .join("  "),
    )
    .join("\n")}\n`;
};

const listRepositoriesTool = defineBackofficeRuntimeTool({
  id: "github.repositories.list",
  namespace: "github",
  name: "listRepositories",
  description: "List GitHub repositories connected to the current organization and their ids.",
  requiredPermissions: ["read"],
  inputSchema: listRepositoriesInputSchema,
  outputSchema: z.array(githubRepositorySchema),
  execute: async (input, context: GitHubToolContext) =>
    await getGitHubRuntime(context.runtimes.github).listRepositories(input),
  adapters: {
    bash: {
      command: "github.repositories.list",
      help: {
        summary: "List connected GitHub repositories and the ids used by other GitHub commands.",
        options: [
          {
            name: "link-key",
            valueRequired: true,
            valueName: "key",
            description: "Only list repositories connected under this link key.",
          },
        ],
        examples: [
          "github.repositories.list",
          "github.repositories.list --format json",
          "github.repositories.list --link-key default",
        ],
      },
      parse: defineCliArgsParser<{ linkKey?: string }>("github.repositories.list", {
        linkKey: {},
      }),
      outputOptions: (args) => readOutputOptions(parseCliTokens(args)),
      format: (repositories, options) =>
        options.format === "json" || options.print
          ? { data: repositories }
          : { stdout: formatRepositoriesTable(repositories) },
    },
  },
});

const createRepositoryAccessTokenTool = defineBackofficeRuntimeTool({
  id: "github.repositories.create-access-token",
  namespace: "github",
  name: "createRepositoryAccessToken",
  description:
    "Create a repository-scoped, read-only GitHub App installation token for cloning a linked repository. The token expires after one hour.",
  requiredPermissions: ["read"],
  inputSchema: createRepositoryAccessTokenInputSchema,
  outputSchema: githubRepositoryAccessTokenSchema,
  execute: async (input, context: GitHubToolContext) =>
    await getGitHubRuntime(context.runtimes.github).createRepositoryAccessToken(input),
  adapters: {
    bash: {
      command: "github.repositories.create-access-token",
      help: {
        summary: "Create a short-lived read token for a linked GitHub repository.",
        options: [
          {
            name: "repo-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Linked GitHub repository id.",
          },
          {
            name: "link-key",
            valueRequired: true,
            valueName: "key",
            description: "Repository link key. Uses the configured default when omitted.",
          },
        ],
        examples: ["github.repositories.create-access-token --repo-id 123456"],
      },
      parse: defineCliArgsParser<{ repoId: string; linkKey?: string }>(
        "github.repositories.create-access-token",
        {
          repoId: { required: true },
          linkKey: {},
        },
      ),
      outputOptions: (args) => {
        const parsed = parseCliTokens(args);
        const output = readOutputOptions(parsed);
        return output.print || parsed.options.has("format")
          ? output
          : { ...output, format: "json" as const };
      },
      format: (result, options) =>
        options.format === "text" && !options.print
          ? {
              stdout: [
                `token: ${result.token}`,
                `expires at: ${result.expiresAt}`,
                `repository: ${result.repository.fullName} (${result.repository.id})`,
                "",
              ].join("\n"),
            }
          : { data: result },
    },
  },
});

export const githubRuntimeTools = [listRepositoriesTool, createRepositoryAccessTokenTool] as const;

export const githubToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "github",
  permissions: {
    read: "Create read-only clone credentials for linked GitHub repositories.",
  },
  tools: githubRuntimeTools,
  isAvailable: (context: GitHubToolContext) => !!context.runtimes.github,
});
