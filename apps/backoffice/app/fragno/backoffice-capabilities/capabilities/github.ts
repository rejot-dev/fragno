import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const githubUserSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  login: z.string().min(1),
  type: z.string().optional(),
  html_url: z.string().optional(),
});

const githubRepositorySchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  html_url: z.string().optional(),
  default_branch: z.string().nullable().optional(),
  owner: githubUserSchema.nullable().optional(),
});

const githubIssueSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  number: z.number(),
  title: z.string(),
  state: z.string().min(1),
  html_url: z.string().optional(),
  user: githubUserSchema.nullable().optional(),
});

const githubPullRequestRefSchema = z.looseObject({
  ref: z.string().min(1),
  sha: z.string().min(1),
});

const githubPullRequestSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  number: z.number(),
  title: z.string(),
  state: z.string().min(1),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  html_url: z.string().optional(),
  user: githubUserSchema.nullable().optional(),
  head: githubPullRequestRefSchema.optional(),
  base: githubPullRequestRefSchema.optional(),
});

const githubActorSchema = z.object({
  scope: z.literal("external"),
  source: z.literal("github"),
  type: z.string().min(1),
  id: z.string().min(1),
  login: z.string().optional(),
  role: z.string().optional(),
});

const githubSubjectSchema = z.object({
  orgId: z.string().min(1),
  installationId: z.string().min(1),
  accountId: z.string().optional(),
  accountLogin: z.string().optional(),
  repositoryId: z.string().optional(),
  repositoryFullName: z.string().optional(),
  issueNumber: z.string().optional(),
  pullRequestNumber: z.string().optional(),
});

const githubPayloadSchema = z.object({
  deliveryId: z.string().min(1),
  githubEvent: z.string().min(1),
  action: z.string().nullable(),
  installationId: z.string().min(1),
  sender: githubUserSchema.nullable().optional(),
  repository: githubRepositorySchema.nullable().optional(),
  issue: githubIssueSchema.nullable().optional(),
  pullRequest: githubPullRequestSchema.nullable().optional(),
  raw: z.record(z.string(), z.unknown()),
});

const GITHUB_AUTOMATION_SOURCE = "github" as const;
const GITHUB_AUTOMATION_EVENT_WEBHOOK_RECEIVED = "webhook.received" as const;

export const githubCapability: BackofficeCapability = {
  id: "github",
  label: "GitHub",
  kind: "connection",
  runtimeToolNamespaces: [],
  connection: {
    configurable: false,
    getStatus: async ({ config }) => ({
      id: "github",
      label: "GitHub",
      kind: "connection",
      configured: config.bindings.github,
      config: { configurationScope: "environment" },
      nextSteps: ["Configure the GitHub App environment and installation."],
    }),
  },
  hooks: [
    {
      id: "github",
      label: "GitHub",
      getRepository: ({ objects, orgId }) =>
        objects.github.forOrg(orgId).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: GITHUB_AUTOMATION_SOURCE,
      eventType: GITHUB_AUTOMATION_EVENT_WEBHOOK_RECEIVED,
      label: "GitHub webhook received",
      description: "Fires when a GitHub App webhook is received for an organisation.",
      payloadSchema: githubPayloadSchema,
      actorSchema: githubActorSchema,
      subjectSchema: githubSubjectSchema,
      example: {
        deliveryId: "delivery-123",
        githubEvent: "pull_request",
        action: "opened",
        installationId: "123456",
        repository: { id: 1, name: "project", full_name: "acme/project", private: false },
        pullRequest: { id: 10, number: 7, title: "Add webhook support", state: "open" },
        sender: { id: 42, login: "octocat" },
        raw: {},
      },
    },
  ],
};
