import type {
  IntegrationInspection,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { generateTelegramWebhookSecretToken } from "@/fragno/telegram-webhook-secret";

import { createTelegramRuntime } from "../telegram-runtime";
import type { IntegrationSetupOperation } from "./integration-contracts";
import { connectionStateOfInspection } from "./integration-events";
import {
  checkedIntegrationActionDefinition,
  type IntegrationActionImplementation,
  type IntegrationContext,
  type IntegrationImplementation,
} from "./integration-implementation";

const telegramConnectionId = "backoffice#telegram";
export const telegramConnectionIdentity = {
  connectionId: telegramConnectionId,
  integrationId: "telegram",
  name: "Telegram",
  authMethod: "api-key" as const,
};
const telegramSetupInputSchema = z.strictObject({
  botToken: z.string().trim().min(1).describe("Secret bot token issued by BotFather."),
  botUsername: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe(
      "Bot username, with or without @. Commands addressed to another bot, such as /start@other_bot, are ignored only when this is set.",
    ),
});
const telegramWebhookCheckIdentity = { id: "webhook.read", label: "Read webhook registration" };

const parseModeSchema = z
  .enum(["MarkdownV2", "Markdown", "HTML"])
  .nullable()
  .describe("Null sends plain text.");
const fileIdInputSchema = z.strictObject({
  fileId: z.string().trim().min(1).describe("Attachment fileId from message.received."),
});
const fileMetadataOutputSchema = z.strictObject({
  fileId: z.string(),
  fileUniqueId: z.string().nullable(),
  filePath: z.string().nullable(),
  fileSize: z.number().int().nullable(),
});

function defineTelegramAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType<JsonValue>,
>(action: {
  id: string;
  label: string;
  description: string;
  input: TInput;
  output: TOutput;
  run: (
    runtime: ReturnType<typeof createTelegramRuntime>,
    input: z.output<TInput>,
  ) => Promise<z.input<TOutput>>;
}) {
  const definition = checkedIntegrationActionDefinition(action);
  return {
    bind(runtime: ReturnType<typeof createTelegramRuntime>): IntegrationActionImplementation {
      return {
        definition: definition(),
        async invoke(input) {
          return action.output.parse(await action.run(runtime, action.input.parse(input)));
        },
      };
    },
  };
}

// The receiving object enforces integrations.execute on each action's routes.
const telegramActions = [
  defineTelegramAction({
    id: "messages.send",
    label: "Send message",
    description: "Queue a message to a Telegram chat the bot can reach.",
    input: z.strictObject({
      chatId: z.string().trim().min(1).describe("Telegram chat ID from message.received."),
      text: z.string().trim().min(1),
      parseMode: parseModeSchema,
      disableWebPagePreview: z.boolean(),
      replyToMessageId: z.number().int().nullable().describe("Null sends a standalone message."),
    }),
    output: z.strictObject({ ok: z.boolean(), queued: z.boolean() }),
    run: (runtime, input) => runtime.sendMessage(input),
  }),
  defineTelegramAction({
    id: "messages.edit",
    label: "Edit message",
    description: "Queue an edit of a message the bot sent.",
    input: z.strictObject({
      chatId: z.string().trim().min(1).describe("Telegram chat ID from message.received."),
      messageId: z.string().trim().min(1),
      text: z.string().trim().min(1),
      parseMode: parseModeSchema,
      disableWebPagePreview: z.boolean(),
    }),
    output: z.strictObject({ ok: z.boolean(), queued: z.boolean() }),
    run: (runtime, input) => runtime.editMessage(input),
  }),
  defineTelegramAction({
    id: "chat-actions.send",
    label: "Send chat action",
    description: "Show a typing indicator in a Telegram chat.",
    input: z.strictObject({
      chatId: z.string().trim().min(1).describe("Telegram chat ID from message.received."),
      action: z.literal("typing"),
    }),
    output: z.strictObject({ ok: z.boolean() }),
    run: (runtime, input) => runtime.sendChatAction(input),
  }),
  defineTelegramAction({
    id: "files.get",
    label: "Get file metadata",
    description: "Resolve a received attachment's metadata.",
    input: fileIdInputSchema,
    output: fileMetadataOutputSchema,
    run: (runtime, input) => runtime.getFile(input),
  }),
  defineTelegramAction({
    id: "files.download",
    label: "Download file",
    description: "Download a received attachment's bytes.",
    input: fileIdInputSchema,
    output: z.strictObject({
      bytes: z.array(z.number().int().min(0).max(255)),
      contentType: z.string().nullable(),
    }),
    run: async (runtime, input) => {
      const response = await runtime.downloadFile(input);
      return {
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        contentType: response.headers.get("content-type"),
      };
    },
  }),
];

function inspectTelegramConfiguration(configured: boolean): IntegrationInspection {
  return {
    configuration: configured
      ? { status: "configured" }
      : { status: "missing", missingFields: ["botToken"] },
    authorization: { status: configured ? "available" : "missing" },
    checks: [
      {
        ...telegramWebhookCheckIdentity,
        status: "not-checked",
        reason: configured
          ? "No retained live webhook check is available."
          : "Configure the Telegram bot token before checking its webhook.",
      },
    ],
    nextSteps: configured ? [] : ["Provide a BotFather bot token for this scope's Telegram bot."],
  };
}

function requestTelegramInput(instructions: string): IntegrationSetupProgress {
  return {
    status: "needs-input",
    connectionId: telegramConnectionId,
    instructions,
    inputSchema: z.toJSONSchema(telegramSetupInputSchema, { io: "input" }),
    secretFields: ["botToken"],
  };
}

function assertTelegramLocalId(localId: string) {
  if (localId !== telegramConnectionIdentity.integrationId) {
    throw new Error("Telegram integration connection not found.");
  }
}

/** Projects the scope's Telegram bot configuration without owning credentials or setup attempts. */
export function createTelegramIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  // Every scope, including system, has its own bot slot.
  const unavailableReason = runtime.config.bindings.telegram
    ? null
    : "The Telegram object binding is unavailable.";

  function getTelegramObject(context: IntegrationContext) {
    if (unavailableReason !== null) {
      throw new BackofficeUnavailableError(unavailableReason);
    }
    return context.kernel.scoped("TELEGRAM", context.execution.scope, runtime.objects.telegram);
  }

  async function readConfiguration(context: IntegrationContext) {
    const object = getTelegramObject(context);
    return await context.kernel.invoke({
      execution: context.execution,
      operation: BACKOFFICE_PERMISSION.connections.read,
      resource: { capabilityId: "telegram" },
      execute: () => object.commands.getAdminConfig(),
    });
  }

  async function readConfigured(context: IntegrationContext) {
    return (await readConfiguration(context)).configured;
  }

  /** The native command replaces any stored bot, so callers decide whether replacing is allowed. */
  async function saveBot(
    context: IntegrationContext,
    input: unknown,
  ): Promise<IntegrationSetupProgress> {
    const values = telegramSetupInputSchema.parse(input);
    const object = getTelegramObject(context);
    const saved = await context.kernel.invoke({
      execution: context.execution,
      operation: BACKOFFICE_PERMISSION.connections.manage,
      resource: { capabilityId: "telegram" },
      execute: () =>
        object.commands.setAdminConfig({
          botToken: values.botToken,
          ...(values.botUsername === null ? {} : { botUsername: values.botUsername }),
          webhookSecretToken: generateTelegramWebhookSecretToken(),
        }),
    });
    // The bot is stored before Telegram is asked to deliver updates, so sending works either way.
    if (saved.webhook && !saved.webhook.ok) {
      return {
        status: "blocked",
        connectionId: telegramConnectionId,
        reason: `The bot token is saved and messages can be sent, but Telegram did not register the webhook, so received messages will not arrive: ${saved.webhook.message} Fix the cause, then reconfigure.`,
      };
    }
    return { status: "ready", connectionId: telegramConnectionId };
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
    assertTelegramLocalId(localId);
    if (unavailableReason !== null) {
      return { status: "blocked", connectionId: telegramConnectionId, reason: unavailableReason };
    }
    const configured = await readConfigured(context);
    if (intent === "setup" && configured) {
      return { status: "ready", connectionId: telegramConnectionId };
    }
    if (intent === "reconfigure" && !configured) {
      return {
        status: "blocked",
        connectionId: telegramConnectionId,
        reason: "Telegram is not configured in this scope. Run setup instead.",
      };
    }
    if (operation.kind === "input") {
      return await saveBot(context, operation.input);
    }
    return requestTelegramInput(
      intent === "setup"
        ? "Provide a bot token. Without a bot, the user opens @BotFather in Telegram, sends /newbot, chooses a display name and a username ending in bot, and copies the token it returns. The token works like a password: regenerate it in BotFather if it leaks. Backoffice registers this deployment as the bot's webhook."
        : "Submit the bot token to use. It replaces the stored bot immediately and registers the webhook again.",
    );
  }

  return {
    connectionIds: [{ kind: "exact", connectionId: telegramConnectionId }],
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
        assertTelegramLocalId(localId);
        if (!(await readConfigured(context))) {
          return { connectionId: telegramConnectionId, status: "not-configured" };
        }
        const object = getTelegramObject(context);
        await context.kernel.invoke({
          execution: context.execution,
          operation: BACKOFFICE_PERMISSION.connections.manage,
          resource: { capabilityId: "telegram" },
          execute: () => object.commands.resetAdminConfig(),
        });
        return { connectionId: telegramConnectionId, status: "disconnected" };
      },
    },
    async discover() {
      return [
        {
          id: telegramConnectionIdentity.integrationId,
          label: telegramConnectionIdentity.name,
          description: "A Telegram bot that receives chat messages and replies to them.",
          connectionCardinality: "singleton",
          availability:
            unavailableReason === null
              ? { status: "available" }
              : { status: "unavailable", reason: unavailableReason },
          setupTargets: [{ kind: "connection", connectionId: telegramConnectionId }],
          automationEvents: [{ source: "telegram", eventType: "message.received" }],
        },
      ];
    },
    async list(context, cursor) {
      if (cursor !== null) {
        throw new Error("Telegram integration listing cursor is invalid.");
      }
      if (unavailableReason !== null || !(await readConfigured(context))) {
        return { connections: [], cursor: null };
      }
      return {
        connections: [
          {
            ...telegramConnectionIdentity,
            ...inspectTelegramConfiguration(true),
            configuration: { status: "configured" },
          },
        ],
        cursor: null,
      };
    },
    async resolve(context, localId) {
      assertTelegramLocalId(localId);
      const object = getTelegramObject(context);
      return {
        identity: telegramConnectionIdentity,
        async inspect() {
          return inspectTelegramConfiguration(await readConfigured(context));
        },
        async state() {
          return connectionStateOfInspection(
            inspectTelegramConfiguration(await readConfigured(context)),
          );
        },
        async details() {
          return { kind: "native" };
        },
        async settings() {
          const { configured, config } = await readConfiguration(context);
          return configured ? { botUsername: config?.botUsername ?? null } : null;
        },
        async actions() {
          const telegram = createTelegramRuntime({
            object,
            execution: context.execution,
            kernel: context.kernel,
          });
          return telegramActions.map((action) => action.bind(telegram));
        },
        async verify() {
          const inspection = inspectTelegramConfiguration(await readConfigured(context));
          if (inspection.configuration.status === "missing") {
            return inspection;
          }
          const webhook = await context.kernel.invoke({
            execution: context.execution,
            operation: BACKOFFICE_PERMISSION.connections.read,
            resource: { checkId: telegramWebhookCheckIdentity.id },
            execute: () => object.commands.checkWebhook(),
          });
          return {
            ...inspection,
            checks: [
              {
                ...telegramWebhookCheckIdentity,
                status: webhook.registered ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message: webhook.message,
              },
            ],
            nextSteps: webhook.registered
              ? []
              : ["Reconfigure Telegram to register this deployment's webhook again."],
          };
        },
      };
    },
  };
}
