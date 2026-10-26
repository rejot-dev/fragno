import { backofficeOrganizationScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

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
  scope: backofficeOrganizationScopeSchema,
  installationId: z.string().min(1),
  accountId: z.string().optional(),
  accountLogin: z.string().optional(),
  connectionId: z
    .string()
    .optional()
    .describe("Integration address github#owner/repo, present for repository webhooks."),
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

/** Keeps the delivery's identity and what names it, such as `#42 Flaky deploy check`. */
function storedGitHubPayload(payload: Record<string, unknown>) {
  // The automation fragment validated the payload against `githubPayloadSchema` before storing it.
  const { deliveryId, githubEvent, action, installationId, issue, pullRequest } =
    payload as z.infer<typeof githubPayloadSchema>;
  return {
    deliveryId,
    githubEvent,
    action,
    installationId,
    issue: issue ? { number: issue.number, title: issue.title } : null,
    pullRequest: pullRequest ? { number: pullRequest.number, title: pullRequest.title } : null,
  };
}

const GITHUB_AUTOMATION_SOURCE = "github" as const;
const GITHUB_AUTOMATION_EVENT_WEBHOOK_RECEIVED = "webhook.received" as const;

export const githubCapability: BackofficeCapability = {
  id: "github",
  label: "GitHub",
  objectBinding: null,
  contributions: {
    connection: {
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
        getRepository: ({ objects, organization }) =>
          createDurableHookRepositoryFromCommands(objects.github.for(organization).commands),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      {
        source: GITHUB_AUTOMATION_SOURCE,
        eventType: GITHUB_AUTOMATION_EVENT_WEBHOOK_RECEIVED,
        label: "GitHub webhook received",
        description:
          "Fires when a GitHub App webhook is received for an organization. Routes see the whole delivery; the stored event keeps only deliveryId, githubEvent, action, installationId, and the number and title of issue and pullRequest. Read the delivery with a GitHub connection's delivery.get action while GitHub's retention keeps it.",
        payloadSchema: githubPayloadSchema,
        storedPayload: storedGitHubPayload,
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
  },
};
