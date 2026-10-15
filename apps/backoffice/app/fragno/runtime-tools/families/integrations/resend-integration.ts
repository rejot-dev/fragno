import type {
  IntegrationAction,
  IntegrationInspection,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import {
  isoDateTimeOutputSchema,
  nullableIsoDateTimeOutputSchema,
} from "@fragno-dev/backoffice-api/v0/shared/datetime";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { createResendRuntime } from "../resend-runtime";
import type { IntegrationSetupOperation } from "./integration-contracts";
import { connectionStateOfInspection } from "./integration-events";
import type {
  IntegrationActionImplementation,
  IntegrationContext,
  IntegrationImplementation,
} from "./integration-implementation";

const resendConnectionId = "backoffice#resend";
export const resendConnectionIdentity = {
  connectionId: resendConnectionId,
  integrationId: "resend",
  name: "Resend",
  authMethod: "api-key" as const,
};
const resendSetupInputSchema = z.strictObject({
  apiKey: z.string().trim().min(1).describe("Secret Resend API key with webhook access."),
  defaultFrom: z
    .string()
    .trim()
    .min(1)
    .describe("Sender address on a verified Resend domain, e.g. Support <support@example.com>."),
  defaultReplyTo: z
    .array(z.string().trim().min(1))
    .describe("Reply-to addresses for sent email. An empty list replies to the sender."),
});
const resendWebhookCheckIdentity = { id: "webhook.read", label: "Read webhook registration" };

type ResendRuntime = ReturnType<typeof createResendRuntime>;

const pageInputShape = {
  cursor: z.string().trim().min(1).nullable().describe("Null starts from the first page."),
  pageSize: z.number().int().min(1).max(100).nullable().describe("Null uses the default size."),
  order: z.enum(["asc", "desc"]).nullable().describe("Null uses the default order."),
};
const resendThreadSummaryOutputSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  normalizedSubject: z.string(),
  participants: z.array(z.string()),
  messageCount: z.number().int().nonnegative(),
  firstMessageAt: isoDateTimeOutputSchema,
  lastMessageAt: isoDateTimeOutputSchema,
  lastDirection: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  createdAt: isoDateTimeOutputSchema,
  updatedAt: isoDateTimeOutputSchema,
});

const resendThreadDetailOutputSchema = resendThreadSummaryOutputSchema.extend({
  replyToAddress: z.string().nullable(),
});

const resendThreadMessageOutputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  status: z.string(),
  from: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string().nullable(),
  normalizedSubject: z.string(),
  participants: z.array(z.string()),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  providerEmailId: z.string().nullable(),
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string().nullable(),
      size: z.number().int().nonnegative(),
      contentType: z.string(),
      contentDisposition: z.string().nullable(),
      contentId: z.string().nullable(),
    }),
  ),
  html: z.string().nullable(),
  text: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  occurredAt: isoDateTimeOutputSchema,
  scheduledAt: nullableIsoDateTimeOutputSchema,
  sentAt: nullableIsoDateTimeOutputSchema,
  lastEventType: z.string().nullable(),
  lastEventAt: nullableIsoDateTimeOutputSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: isoDateTimeOutputSchema,
  updatedAt: isoDateTimeOutputSchema,
});

function defineResendAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType<JsonValue>,
>(action: {
  id: string;
  label: string;
  description: string;
  input: TInput;
  output: TOutput;
  run: (runtime: ResendRuntime, input: z.output<TInput>) => Promise<z.input<TOutput>>;
}) {
  const definition: IntegrationAction = {
    id: action.id,
    label: action.label,
    description: action.description,
    validation: { kind: "checked" },
    inputSchema: z.toJSONSchema(action.input, { io: "input" }),
    outputSchema: z.toJSONSchema(action.output, { io: "output" }),
  };
  return {
    bind(runtime: ResendRuntime): IntegrationActionImplementation {
      return {
        definition,
        async invoke(input) {
          return action.output.parse(await action.run(runtime, action.input.parse(input)));
        },
      };
    },
  };
}

// The receiving object enforces integrations.execute on each action's routes.
const resendActions = [
  defineResendAction({
    id: "threads.list",
    label: "List threads",
    description: "List email threads, most recent activity first by default.",
    input: z.strictObject(pageInputShape),
    output: z.strictObject({
      threads: z.array(resendThreadSummaryOutputSchema),
      cursor: z.string().nullable().describe("Null means there are no further pages."),
      hasNextPage: z.boolean(),
    }),
    run: (runtime, input) => runtime.listThreads(input),
  }),
  defineResendAction({
    id: "threads.get",
    label: "Read thread",
    description: "Read a thread with one page of its messages and a Markdown transcript.",
    input: z.strictObject({ threadId: z.string().trim().min(1), ...pageInputShape }),
    output: z.strictObject({
      thread: resendThreadDetailOutputSchema,
      messages: z.array(resendThreadMessageOutputSchema),
      cursor: z.string().nullable().describe("Null means there are no further pages."),
      hasNextPage: z.boolean(),
      markdown: z.string(),
    }),
    run: (runtime, input) => runtime.getThreadSnapshot(input),
  }),
  defineResendAction({
    id: "threads.reply",
    label: "Reply to thread",
    description:
      "Send a plain-text reply to the latest inbound message's reply-to address, or its sender.",
    input: z.strictObject({
      threadId: z.string().trim().min(1),
      subject: z.string().trim().min(1).nullable().describe("Null keeps the thread subject."),
      body: z.string().trim().min(1),
    }),
    output: z.strictObject({
      thread: resendThreadDetailOutputSchema,
      message: resendThreadMessageOutputSchema,
    }),
    run: (runtime, input) => runtime.replyToThread(input),
  }),
];

function inspectResendConfiguration(configured: boolean): IntegrationInspection {
  return {
    configuration: configured
      ? { status: "configured" }
      : { status: "missing", missingFields: ["apiKey", "defaultFrom"] },
    authorization: { status: configured ? "available" : "missing" },
    checks: [
      {
        ...resendWebhookCheckIdentity,
        status: "not-checked",
        reason: configured
          ? "No retained live webhook check is available."
          : "Configure Resend before checking its webhook.",
      },
    ],
    nextSteps: configured ? [] : ["Provide a Resend API key and sender address for this scope."],
  };
}

function requestResendInput(instructions: string): IntegrationSetupProgress {
  return {
    status: "needs-input",
    connectionId: resendConnectionId,
    instructions,
    inputSchema: z.toJSONSchema(resendSetupInputSchema, { io: "input" }),
    secretFields: ["apiKey"],
  };
}

function assertResendLocalId(localId: string) {
  if (localId !== resendConnectionIdentity.integrationId) {
    throw new Error("Resend integration connection not found.");
  }
}

/** Projects the scope's Resend configuration without owning credentials or setup attempts. */
export function createResendIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  // The system slot is the platform account Backoffice sends its own email through.
  function unavailableReason(context: IntegrationContext) {
    const { kind } = context.execution.scope;
    if (kind !== "org" && kind !== "system") {
      return "Resend connections belong to an organization or the system scope.";
    }
    return runtime.config.bindings.resend ? null : "The Resend object binding is unavailable.";
  }

  function getResendObject(context: IntegrationContext) {
    const reason = unavailableReason(context);
    if (reason !== null) {
      throw new BackofficeUnavailableError(reason);
    }
    return context.kernel.scoped("RESEND", context.execution.scope, runtime.objects.resend);
  }

  async function readConfiguration(context: IntegrationContext) {
    const object = getResendObject(context);
    return await context.kernel.invoke({
      execution: context.execution,
      operation: BACKOFFICE_PERMISSION.connections.read,
      resource: { capabilityId: "resend" },
      execute: () => object.commands.getAdminConfig(),
    });
  }

  async function readConfigured(context: IntegrationContext) {
    return (await readConfiguration(context)).configured;
  }

  /** Saving registers a webhook, so it also needs a public origin for Resend to deliver to. */
  function saveAvailability(
    context: IntegrationContext,
  ): { status: "blocked"; reason: string } | { status: "available"; publicBaseUrl: string } {
    const reason = unavailableReason(context);
    if (reason !== null) {
      return { status: "blocked", reason };
    }
    const publicBaseUrl = runtime.config.docsPublicBaseUrl;
    return publicBaseUrl === undefined
      ? {
          status: "blocked",
          reason:
            "Backoffice has no public base URL (DOCS_PUBLIC_BASE_URL) for Resend to deliver webhooks to.",
        }
      : { status: "available", publicBaseUrl };
  }

  /** The native command replaces stored values, so callers decide whether replacing is allowed. */
  async function save(
    context: IntegrationContext,
    publicBaseUrl: string,
    input: unknown,
  ): Promise<IntegrationSetupProgress> {
    const values = resendSetupInputSchema.parse(input);
    const scope = context.execution.scope;
    if (scope.kind !== "org" && scope.kind !== "system") {
      throw new BackofficeUnavailableError(
        "Resend connections belong to an organization or the system scope.",
      );
    }
    const object = getResendObject(context);
    const saved = await context.kernel.invoke({
      execution: context.execution,
      operation: BACKOFFICE_PERMISSION.connections.manage,
      resource: { capabilityId: "resend" },
      execute: () =>
        object.commands.setAdminConfig(
          { ...values, webhookBaseUrl: publicBaseUrl },
          scope,
          publicBaseUrl,
        ),
    });
    // Resend must register the webhook before anything is stored, so a rejection keeps the previous
    // configuration, if any.
    if (!saved.webhook?.ok) {
      return requestResendInput(
        `Resend rejected the configuration, so nothing changed: ${saved.webhook?.message ?? "no webhook result"}. Submit corrected values.`,
      );
    }
    return { status: "ready", connectionId: resendConnectionId };
  }

  /**
   * Setup fills an empty slot and reconfigure replaces a filled one; both read the slot again and
   * save through the same native command. Setup ignores input once configured, so it never replaces
   * stored credentials.
   */
  async function progress(
    context: IntegrationContext,
    localId: string,
    operation: IntegrationSetupOperation,
    intent: "setup" | "reconfigure",
  ): Promise<IntegrationSetupProgress> {
    assertResendLocalId(localId);
    const availability = saveAvailability(context);
    if (availability.status === "blocked") {
      return { status: "blocked", connectionId: resendConnectionId, reason: availability.reason };
    }
    const configured = await readConfigured(context);
    if (intent === "setup" && configured) {
      return { status: "ready", connectionId: resendConnectionId };
    }
    if (intent === "reconfigure" && !configured) {
      return {
        status: "blocked",
        connectionId: resendConnectionId,
        reason: "Resend is not configured in this scope. Run setup instead.",
      };
    }
    if (operation.kind === "input") {
      return await save(context, availability.publicBaseUrl, operation.input);
    }
    return requestResendInput(
      intent === "setup"
        ? "Provide a Resend API key and sender address. Backoffice registers this deployment as the account's webhook for sent and received email."
        : "Submit the Resend values to use. They replace the stored ones once Resend accepts the webhook.",
    );
  }

  return {
    connectionIds: [{ kind: "exact", connectionId: resendConnectionId }],
    setup: {
      kind: "supported",
      run: (context, { localId, operation }) => progress(context, localId, operation, "setup"),
    },
    reconfigure: {
      kind: "supported",
      run: (context, { localId, operation }) =>
        progress(context, localId, operation, "reconfigure"),
    },
    disconnect: {
      kind: "supported",
      async run(context, { localId }) {
        assertResendLocalId(localId);
        if (!(await readConfigured(context))) {
          return { connectionId: resendConnectionId, status: "not-configured" };
        }
        const object = getResendObject(context);
        await context.kernel.invoke({
          execution: context.execution,
          operation: BACKOFFICE_PERMISSION.connections.manage,
          resource: { capabilityId: "resend" },
          execute: () => object.commands.resetAdminConfig(),
        });
        return { connectionId: resendConnectionId, status: "disconnected" };
      },
    },
    async discover(context) {
      const reason = unavailableReason(context);
      return [
        {
          id: resendConnectionIdentity.integrationId,
          label: resendConnectionIdentity.name,
          description:
            context.execution.scope.kind === "system"
              ? "The platform Resend account Backoffice sends its own email through, such as email verification. Disconnecting or misconfiguring it stops that email for every user."
              : "Email threads sent and received through the organization's Resend account.",
          connectionCardinality: "singleton",
          availability:
            reason === null ? { status: "available" } : { status: "unavailable", reason },
          setupTargets: [{ kind: "connection", connectionId: resendConnectionId }],
          automationEvents: [],
        },
      ];
    },
    async list(context, cursor) {
      if (cursor !== null) {
        throw new Error("Resend integration listing cursor is invalid.");
      }
      if (unavailableReason(context) !== null || !(await readConfigured(context))) {
        return { connections: [], cursor: null };
      }
      return {
        connections: [
          {
            ...resendConnectionIdentity,
            ...inspectResendConfiguration(true),
            configuration: { status: "configured" },
          },
        ],
        cursor: null,
      };
    },
    async resolve(context, localId) {
      assertResendLocalId(localId);
      const object = getResendObject(context);
      return {
        identity: resendConnectionIdentity,
        async inspect() {
          return inspectResendConfiguration(await readConfigured(context));
        },
        async state() {
          return connectionStateOfInspection(
            inspectResendConfiguration(await readConfigured(context)),
          );
        },
        async details() {
          return { kind: "native" };
        },
        async settings() {
          const { configured, config } = await readConfiguration(context);
          return configured
            ? {
                ...(config?.defaultFrom ? { defaultFrom: config.defaultFrom } : {}),
                defaultReplyTo: config?.defaultReplyTo ?? [],
              }
            : null;
        },
        async actions() {
          const resend = createResendRuntime({
            object: authorizedBackofficeObjectHttp(object.http, context.execution),
          });
          return resendActions.map((action) => action.bind(resend));
        },
        async verify() {
          const inspection = inspectResendConfiguration(await readConfigured(context));
          if (inspection.configuration.status === "missing") {
            return inspection;
          }
          const webhook = await context.kernel.invoke({
            execution: context.execution,
            operation: BACKOFFICE_PERMISSION.connections.read,
            resource: { checkId: resendWebhookCheckIdentity.id },
            execute: () => object.commands.checkWebhook(),
          });
          return {
            ...inspection,
            checks: [
              {
                ...resendWebhookCheckIdentity,
                status: webhook.registered ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message: webhook.message,
              },
            ],
            nextSteps: webhook.registered
              ? []
              : ["Reconfigure Resend to register this deployment's webhook again."],
          };
        },
      };
    },
  };
}
