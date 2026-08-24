/// <reference path="/static/codemode/workflow-authoring.d.ts" />

defineWorkflow(
  { name: "install-github-channel" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    if (event.payload.targetScope.kind !== "org") {
      throw new Error("GitHub Channel must be installed into an organization automation scope.");
    }

    const stringOrNumberSchema = {
      anyOf: [{ type: "number" }, { type: "string" }],
    };
    const githubUserSchema = {
      type: "object",
      properties: {
        id: stringOrNumberSchema,
        login: { type: "string", minLength: 1 },
        type: { type: "string" },
        html_url: { type: "string" },
      },
      required: ["id", "login"],
      additionalProperties: true,
    };
    const nullableGithubUserSchema = {
      anyOf: [githubUserSchema, { type: "null" }],
    };
    const githubRepositorySchema = {
      type: "object",
      properties: {
        id: stringOrNumberSchema,
        name: { type: "string", minLength: 1 },
        full_name: { type: "string", minLength: 1 },
        private: { type: "boolean" },
        html_url: { type: "string" },
        default_branch: { anyOf: [{ type: "string" }, { type: "null" }] },
        owner: nullableGithubUserSchema,
      },
      required: ["id", "name", "full_name", "private"],
      additionalProperties: true,
    };
    const githubIssueSchema = {
      type: "object",
      properties: {
        id: stringOrNumberSchema,
        number: { type: "number" },
        title: { type: "string" },
        state: { type: "string", minLength: 1 },
        html_url: { type: "string" },
        user: nullableGithubUserSchema,
      },
      required: ["id", "number", "title", "state"],
      additionalProperties: true,
    };
    const githubPullRequestRefSchema = {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1 },
        sha: { type: "string", minLength: 1 },
      },
      required: ["ref", "sha"],
      additionalProperties: true,
    };
    const githubPullRequestSchema = {
      type: "object",
      properties: {
        id: stringOrNumberSchema,
        number: { type: "number" },
        title: { type: "string" },
        state: { type: "string", minLength: 1 },
        draft: { type: "boolean" },
        merged: { type: "boolean" },
        html_url: { type: "string" },
        user: nullableGithubUserSchema,
        head: githubPullRequestRefSchema,
        base: githubPullRequestRefSchema,
      },
      required: ["id", "number", "title", "state"],
      additionalProperties: true,
    };
    const githubCommentSchema = {
      type: "object",
      properties: {
        id: stringOrNumberSchema,
        body: { type: "string" },
        html_url: { type: "string" },
        user: nullableGithubUserSchema,
      },
      required: ["id", "body"],
      additionalProperties: true,
    };
    const githubActorSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            scope: { const: "external", type: "string" },
            source: { const: "github", type: "string" },
            type: { type: "string", minLength: 1 },
            id: { type: "string", minLength: 1 },
            role: { const: "initiator", type: "string" },
          },
          required: ["scope", "source", "type", "id", "role"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            scope: { const: "internal", type: "string" },
            type: { const: "system", type: "string" },
            id: { type: "string", minLength: 1 },
            role: { const: "initiator", type: "string" },
          },
          required: ["scope", "type", "id", "role"],
          additionalProperties: false,
        },
      ],
    };
    const githubSubjectSchema = {
      type: "object",
      properties: {
        orgId: { type: "string", minLength: 1 },
        installationId: { type: "string", minLength: 1 },
        accountId: { type: "string" },
        accountLogin: { type: "string" },
        repositoryId: { type: "string" },
        repositoryFullName: { type: "string" },
        issueNumber: { type: "string" },
        pullRequestNumber: { type: "string" },
      },
      required: ["orgId", "installationId"],
      additionalProperties: false,
    };
    /**
     * @param {Record<string, unknown>} properties
     * @param {string[]} required
     */
    const normalizedPayloadSchema = (properties, required) => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        deliveryId: { type: "string", minLength: 1 },
        installationId: { type: "string", minLength: 1 },
        repository: githubRepositorySchema,
        sender: nullableGithubUserSchema,
        ...properties,
      },
      required: ["deliveryId", "installationId", "repository", "sender", ...required],
      additionalProperties: false,
    });
    const eventDefinitions = [
      {
        source: "github",
        eventType: "issues.opened",
        label: "GitHub issue opened",
        description: "Fires when GitHub reports that an issue was opened.",
        payloadSchema: normalizedPayloadSchema({ issue: githubIssueSchema }, ["issue"]),
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
        enabled: true,
      },
      {
        source: "github",
        eventType: "issue_comment.created",
        label: "GitHub issue comment created",
        description: "Fires when GitHub reports a new issue or pull request comment.",
        payloadSchema: normalizedPayloadSchema(
          { issue: githubIssueSchema, comment: githubCommentSchema },
          ["issue", "comment"],
        ),
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
        enabled: true,
      },
      {
        source: "github",
        eventType: "pull_request.opened",
        label: "GitHub pull request opened",
        description: "Fires when GitHub reports that a pull request was opened.",
        payloadSchema: normalizedPayloadSchema({ pullRequest: githubPullRequestSchema }, [
          "pullRequest",
        ]),
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
        enabled: true,
      },
      {
        source: "github",
        eventType: "pull_request.synchronize",
        label: "GitHub pull request synchronized",
        description: "Fires when commits are pushed to a pull request branch.",
        payloadSchema: normalizedPayloadSchema({ pullRequest: githubPullRequestSchema }, [
          "pullRequest",
        ]),
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
        enabled: true,
      },
      {
        source: "github",
        eventType: "push",
        label: "GitHub push",
        description: "Fires when GitHub reports a repository push.",
        payloadSchema: normalizedPayloadSchema(
          {
            ref: { type: "string", minLength: 1 },
            before: { type: "string" },
            after: { type: "string" },
          },
          ["ref", "before", "after"],
        ),
        actorSchema: githubActorSchema,
        subjectSchema: githubSubjectSchema,
        enabled: true,
      },
    ];

    for (const definition of eventDefinitions) {
      await step.do(`create ${definition.eventType} event definition`, async () => {
        // @ts-expect-error -- events is injected into the workflow runtime.
        const existing = await events.catalogGet({
          source: definition.source,
          eventType: definition.eventType,
        });
        if (existing) {
          return existing;
        }

        // @ts-expect-error -- events is injected into the workflow runtime.
        return await events.catalogCreate(definition);
      });
    }

    const routes = [
      {
        id: "github-issues-opened-reclassify",
        name: "Classify opened GitHub issues",
        enabled: true,
        trigger: {
          kind: "event",
          source: "github",
          eventType: "webhook.received",
          matcher: {
            all: [
              { path: "$.payload.githubEvent", op: "eq", value: "issues" },
              { path: "$.payload.action", op: "eq", value: "opened" },
            ],
          },
        },
        priority: 40,
        action: {
          kind: "reclassify_event",
          source: "github",
          eventType: "issues.opened",
          payload: {
            kind: "projection",
            fields: {
              deliveryId: "$.payload.deliveryId",
              installationId: "$.payload.installationId",
              repository: "$.payload.repository",
              issue: "$.payload.issue",
              sender: "$.payload.sender",
            },
          },
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "github-issues-opened-reclassify-route",
          version: event.payload.version,
        },
      },
      {
        id: "github-issue-comment-created-reclassify",
        name: "Classify created GitHub issue comments",
        enabled: true,
        trigger: {
          kind: "event",
          source: "github",
          eventType: "webhook.received",
          matcher: {
            all: [
              { path: "$.payload.githubEvent", op: "eq", value: "issue_comment" },
              { path: "$.payload.action", op: "eq", value: "created" },
            ],
          },
        },
        priority: 40,
        action: {
          kind: "reclassify_event",
          source: "github",
          eventType: "issue_comment.created",
          payload: {
            kind: "projection",
            fields: {
              deliveryId: "$.payload.deliveryId",
              installationId: "$.payload.installationId",
              repository: "$.payload.repository",
              issue: "$.payload.issue",
              comment: "$.payload.raw.comment",
              sender: "$.payload.sender",
            },
          },
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "github-issue-comment-created-reclassify-route",
          version: event.payload.version,
        },
      },
      {
        id: "github-pull-request-opened-reclassify",
        name: "Classify opened GitHub pull requests",
        enabled: true,
        trigger: {
          kind: "event",
          source: "github",
          eventType: "webhook.received",
          matcher: {
            all: [
              { path: "$.payload.githubEvent", op: "eq", value: "pull_request" },
              { path: "$.payload.action", op: "eq", value: "opened" },
            ],
          },
        },
        priority: 40,
        action: {
          kind: "reclassify_event",
          source: "github",
          eventType: "pull_request.opened",
          payload: {
            kind: "projection",
            fields: {
              deliveryId: "$.payload.deliveryId",
              installationId: "$.payload.installationId",
              repository: "$.payload.repository",
              pullRequest: "$.payload.pullRequest",
              sender: "$.payload.sender",
            },
          },
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "github-pull-request-opened-reclassify-route",
          version: event.payload.version,
        },
      },
      {
        id: "github-pull-request-synchronize-reclassify",
        name: "Classify synchronized GitHub pull requests",
        enabled: true,
        trigger: {
          kind: "event",
          source: "github",
          eventType: "webhook.received",
          matcher: {
            all: [
              { path: "$.payload.githubEvent", op: "eq", value: "pull_request" },
              { path: "$.payload.action", op: "eq", value: "synchronize" },
            ],
          },
        },
        priority: 40,
        action: {
          kind: "reclassify_event",
          source: "github",
          eventType: "pull_request.synchronize",
          payload: {
            kind: "projection",
            fields: {
              deliveryId: "$.payload.deliveryId",
              installationId: "$.payload.installationId",
              repository: "$.payload.repository",
              pullRequest: "$.payload.pullRequest",
              sender: "$.payload.sender",
            },
          },
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "github-pull-request-synchronize-reclassify-route",
          version: event.payload.version,
        },
      },
      {
        id: "github-push-reclassify",
        name: "Classify GitHub pushes",
        enabled: true,
        trigger: {
          kind: "event",
          source: "github",
          eventType: "webhook.received",
          matcher: { path: "$.payload.githubEvent", op: "eq", value: "push" },
        },
        priority: 40,
        action: {
          kind: "reclassify_event",
          source: "github",
          eventType: "push",
          payload: {
            kind: "projection",
            fields: {
              deliveryId: "$.payload.deliveryId",
              installationId: "$.payload.installationId",
              repository: "$.payload.repository",
              ref: "$.payload.raw.ref",
              before: "$.payload.raw.before",
              after: "$.payload.raw.after",
              sender: "$.payload.sender",
            },
          },
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "github-push-reclassify-route",
          version: event.payload.version,
        },
      },
    ];

    for (const route of routes) {
      await step.do(`create ${route.id} route`, async () => {
        // @ts-expect-error -- router is injected into the workflow runtime.
        const existing = await router.get({ id: route.id });
        if (existing) {
          return existing;
        }

        // @ts-expect-error -- router is injected into the workflow runtime.
        return await router.create(route);
      });
    }
  },
);
