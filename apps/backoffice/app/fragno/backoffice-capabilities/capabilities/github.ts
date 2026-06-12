import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

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
  sender: z.unknown().nullable().optional(),
  repository: z.unknown().nullable().optional(),
  issue: z.unknown().nullable().optional(),
  pullRequest: z.unknown().nullable().optional(),
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
    getStatus: async ({ env }) => ({
      id: "github",
      label: "GitHub",
      kind: "connection",
      configured: Boolean(env.GITHUB),
      config: { configurationScope: "environment" },
      nextSteps: ["Configure the GitHub App environment and installation."],
    }),
  },
  hooks: [
    {
      id: "github",
      label: "GitHub",
      getRepository: ({ env, orgId }) =>
        env.GITHUB.get(env.GITHUB.idFromName(orgId)).getDurableHookRepository(),
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
        repository: { id: 1, full_name: "acme/project" },
        sender: { id: 42, login: "octocat" },
        raw: {},
      },
    },
  ],
};
