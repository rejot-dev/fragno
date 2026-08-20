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

const githubActorSchema = z.union([
  z.object({
    scope: z.literal("external"),
    source: z.literal("github"),
    type: z.string().min(1),
    id: z.string().min(1),
    role: z.literal("initiator"),
  }),
  z.object({
    scope: z.literal("internal"),
    type: z.literal("system"),
    id: z.string().min(1),
    role: z.literal("initiator"),
  }),
]);

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

const githubCommentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  body: z.string(),
  html_url: z.string().optional(),
  user: githubUserSchema.nullable().optional(),
});

const githubNormalizedPayloadShape = {
  deliveryId: z.string().min(1),
  installationId: z.string().min(1),
  repository: githubRepositorySchema,
  sender: githubUserSchema.nullable(),
};

const githubIssuesOpenedPayloadSchema = z.object({
  ...githubNormalizedPayloadShape,
  issue: githubIssueSchema,
});

const githubIssueCommentCreatedPayloadSchema = z.object({
  ...githubNormalizedPayloadShape,
  issue: githubIssueSchema,
  comment: githubCommentSchema,
});

const githubPullRequestOpenedPayloadSchema = z.object({
  ...githubNormalizedPayloadShape,
  pullRequest: githubPullRequestSchema,
});

const githubPullRequestSynchronizePayloadSchema = z.object({
  ...githubNormalizedPayloadShape,
  pullRequest: githubPullRequestSchema,
});

const githubPushPayloadSchema = z.object({
  ...githubNormalizedPayloadShape,
  ref: z.string().min(1),
  before: z.string(),
  after: z.string(),
});

const GITHUB_AUTOMATION_SOURCE = "github" as const;
const GITHUB_AUTOMATION_EVENT_WEBHOOK_RECEIVED = "webhook.received" as const;

export const githubCapability: BackofficeCapability = {
  id: "github",
  label: "GitHub",
  objectBinding: null,
  contributions: {
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
    eventSources: [
      {
        source: GITHUB_AUTOMATION_SOURCE,
        label: "GitHub",
        description: "Activity received from the connected GitHub App.",
      },
    ],
    actionProviders: [],
    hookScopes: [
      {
        id: "github",
        label: "GitHub",
        getRepository: ({ objects, orgId }) =>
          objects.github.forOrg(orgId).getDurableHookRepository(),
      },
    ],
    skillPaths: [],
    externalEntities: [],
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
      {
        source: GITHUB_AUTOMATION_SOURCE,
        eventType: "issues.opened",
        label: "GitHub issue opened",
        description: "Fires when GitHub reports that an issue was opened.",
        payloadSchema: githubIssuesOpenedPayloadSchema,
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
      },
      {
        source: GITHUB_AUTOMATION_SOURCE,
        eventType: "issue_comment.created",
        label: "GitHub issue comment created",
        description: "Fires when GitHub reports a new issue or pull request comment.",
        payloadSchema: githubIssueCommentCreatedPayloadSchema,
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
      },
      {
        source: GITHUB_AUTOMATION_SOURCE,
        eventType: "pull_request.opened",
        label: "GitHub pull request opened",
        description: "Fires when GitHub reports that a pull request was opened.",
        payloadSchema: githubPullRequestOpenedPayloadSchema,
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
      },
      {
        source: GITHUB_AUTOMATION_SOURCE,
        eventType: "pull_request.synchronize",
        label: "GitHub pull request synchronized",
        description: "Fires when commits are pushed to a pull request branch.",
        payloadSchema: githubPullRequestSynchronizePayloadSchema,
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
      },
      {
        source: GITHUB_AUTOMATION_SOURCE,
        eventType: "push",
        label: "GitHub push",
        description: "Fires when GitHub reports a repository push.",
        payloadSchema: githubPushPayloadSchema,
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
      },
    ],
  },
};
