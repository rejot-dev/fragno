import type {
  IntegrationInspection,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { isoDateTimeOutputSchema } from "@fragno-dev/backoffice-api/v0/shared/datetime";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeUserContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { HookContext } from "@fragno-dev/db";
import {
  MAX_MAILBOX_ATTACHMENT_BYTES,
  type ResendMailbox,
  type ResendMailboxAttachmentInput,
  type ResendReplyFromMailboxResult,
} from "@fragno-dev/resend-fragment";

import { BackofficeForbiddenError, BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  INBOUND_EMAIL_AUTOMATION_SOURCE,
  inboundEmailReceivedPayloadSchema,
} from "@/fragno/backoffice-capabilities/capabilities/resend";
import { checkUsageLimits, usageBillingForScope } from "@/fragno/billing/usage-billing";
import { MAILBOX_EMAIL_SENT_METER } from "@/fragno/billing/usage-limits";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { StateFileReadLimitError } from "@/fragno/codemode/state-backend";
import {
  INBOUND_EMAIL_CONNECTION_ID,
  inboundEmailOwnerScope,
  inboundEmailSenderAddress,
  inboundEmailSenderDomain,
  inboundEmailSenderVerified,
} from "@/fragno/inbound-email";
import { claimRandomInboundAddress } from "@/fragno/inbound-email-address";
import { bytesToBase64 } from "@/lib/base64";

import { INTEGRATION_CATEGORY } from "./integration-categories";
import type { IntegrationSetupOperation } from "./integration-contracts";
import type { IntegrationConnectionState } from "./integration-events";
import { recordIntegrationConnectionState } from "./integration-events";
import {
  checkedIntegrationActionDefinition,
  type IntegrationContext,
  type IntegrationImplementation,
} from "./integration-implementation";

const emailIntegrationId = "email";

const messageGetInputSchema = z.strictObject({
  emailId: z.string().trim().min(1).describe("The emailId of an email.message.received event."),
});
const messageGetOutputSchema = z.strictObject({
  emailId: z.string(),
  address: z.string().describe("The address it arrived at, which may since have been replaced."),
  from: z.string().nullable(),
  senderAddress: inboundEmailReceivedPayloadSchema.shape.senderAddress,
  senderDomain: inboundEmailReceivedPayloadSchema.shape.senderDomain,
  senderVerified: inboundEmailReceivedPayloadSchema.shape.senderVerified,
  authentication: inboundEmailReceivedPayloadSchema.shape.authentication,
  to: z.array(z.string()),
  cc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string().nullable(),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  text: z.string().nullable(),
  html: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  attachments: z.array(
    z.strictObject({
      id: z.string(),
      filename: z.string().nullable(),
      contentType: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
  receivedAt: isoDateTimeOutputSchema,
});
const messageGetActionDefinition = checkedIntegrationActionDefinition({
  id: "message.get",
  label: "Read email",
  description:
    "Read a received email whole: its headers, plain-text and HTML bodies, and attachments.",
  input: messageGetInputSchema,
  output: messageGetOutputSchema,
});
const attachmentGetInputSchema = z.strictObject({
  emailId: z.string().trim().min(1).describe("The emailId of an email.message.received event."),
  attachmentId: z.string().trim().min(1).describe("An id from the email's attachments."),
});
const attachmentGetOutputSchema = z.strictObject({
  id: z.string(),
  filename: z.string().nullable(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  downloadUrl: z.string().describe("Downloads the attachment without credentials until expiresAt."),
  expiresAt: z.string(),
});
const attachmentGetActionDefinition = checkedIntegrationActionDefinition({
  id: "attachment.get",
  label: "Get attachment",
  description:
    "Get a short-lived download URL for an attachment of a received email. Download it right away; a later download needs a new URL.",
  input: attachmentGetInputSchema,
  output: attachmentGetOutputSchema,
});

// The platform account keeps a message's text and attachments until Resend accepts it.
const MAILBOX_EMAIL_MAX_TEXT_LENGTH = 50_000;
const MAILBOX_EMAIL_MAX_ATTACHMENTS = 10;
const mailboxEmailTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAILBOX_EMAIL_MAX_TEXT_LENGTH)
  .describe("Plain text. A line saying Leyway sent it follows.");
const sentEmailOutputSchema = z.strictObject({
  emailId: z
    .string()
    .describe(
      "The sent email; its message.delivered, message.bounced, and message.complained events name it.",
    ),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
});
const messageSendToSelfInputSchema = z.strictObject({
  subject: z.string().trim().min(1).max(200),
  text: mailboxEmailTextSchema,
  attachments: z
    .array(
      z.strictObject({
        path: z
          .string()
          .trim()
          .min(1)
          .describe("A workspace file, such as /workspace/reports/receipts.csv."),
        filename: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The name the recipient sees; the path's file name when omitted."),
      }),
    )
    .max(MAILBOX_EMAIL_MAX_ATTACHMENTS)
    .optional()
    .describe(`Workspace files to attach, at most ${MAX_MAILBOX_ATTACHMENT_BYTES} bytes together.`),
});
const messageSendToSelfActionDefinition = checkedIntegrationActionDefinition({
  id: "message.sendToSelf",
  label: "Email yourself",
  description:
    "Send a plain-text email from this person's address to their own verified account email, such as a summary or a workspace file. It counts toward their monthly email.sent limit.",
  input: messageSendToSelfInputSchema,
  output: sentEmailOutputSchema,
});
const messageReplyInputSchema = z.strictObject({
  emailId: z
    .string()
    .trim()
    .min(1)
    .describe("The emailId of an email.message.received event whose senderVerified is true."),
  text: mailboxEmailTextSchema,
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe("Omitted or null replies under Re: and the received email's subject."),
});
const messageReplyActionDefinition = checkedIntegrationActionDefinition({
  id: "message.reply",
  label: "Reply to email",
  description:
    "Reply in plain text from this person's address to an email it received, at the sender's address. Only verified senders (senderVerified) get replies. It needs the email.send permission and counts toward the monthly email.sent limit. Show the person the reply and get their confirmation first, unless they built this automation to reply.",
  input: messageReplyInputSchema,
  output: sentEmailOutputSchema,
});

/** People see who wrote an email, and that Leyway sent it for them. */
function senderName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `${trimmed} via Leyway` : "Leyway";
}

function inspectMailbox(mailbox: ResendMailbox | null): IntegrationInspection {
  return mailbox !== null && !mailbox.paused
    ? {
        configuration: { status: "configured" },
        authorization: { status: "not-required" },
        checks: [],
        nextSteps: [],
      }
    : {
        configuration: { status: "missing", missingFields: [] },
        authorization: { status: "not-required" },
        checks: [],
        nextSteps: [
          mailbox === null
            ? "Run setup to give this person an address."
            : `Run setup to resume delivery to ${mailbox.address}.`,
        ],
      };
}

type InboundEmailRuntime = Pick<BackofficeRuntimeServices, "objects" | "config">;

/**
 * Records a change the Resend fragment announced, in the transaction that made it, as the state of
 * its owner's connection. Its ready events carry the address, so the Integrations views name it.
 */
export async function recordMailboxChange(
  objects: Pick<BackofficeRuntimeServices["objects"], "automations">,
  mailbox: ResendMailbox,
  context: Pick<HookContext, "hookId" | "createdAt" | "capturePropagationContext">,
) {
  const owner = inboundEmailOwnerScope(mailbox.owner);
  const change = {
    id: context.hookId.toString(),
    scope: owner,
    service: emailIntegrationId,
    connectionId: INBOUND_EMAIL_CONNECTION_ID,
    occurredAt: context.createdAt,
  };
  await recordIntegrationConnectionState(
    objects.automations.for(owner).commands,
    mailbox.paused
      ? { ...change, state: "disconnected" }
      : { ...change, state: "ready", label: { name: mailbox.address, authMethod: "none" } },
    { propagationContext: context.capturePropagationContext() },
  );
}

/** A queued email as actions return it, or why the mailbox did not send it. */
function sentEmail(result: ResendReplyFromMailboxResult, repliedTo?: string) {
  switch (result.status) {
    case "queued":
      return sentEmailOutputSchema.parse({
        emailId: result.email.emailMessageId,
        from: result.email.from,
        to: result.email.to,
        subject: result.email.subject,
      });
    case "not-found":
    case "paused":
      throw new BackofficeUnavailableError(
        "Run setup for this person's address before sending from it.",
      );
    case "sending-suspended":
      throw new BackofficeOperationError(
        "forbidden",
        "Sending from this address is suspended, such as after a recipient marked its email as spam. It still receives; the person can ask support to resume sending.",
      );
    case "email-not-found":
      throw new BackofficeOperationError(
        "not_found",
        `Email ${repliedTo} did not arrive at this person's address.`,
      );
    case "sender-unverified":
      throw new BackofficeOperationError(
        "forbidden",
        `Email ${repliedTo}'s sender is not verified (senderVerified is false), so anyone may have written its From address. Replies go only to verified senders.`,
      );
    default:
      throw new Error("Mailbox send result is unsupported.", { cause: result satisfies never });
  }
}

/**
 * Support's way to give a person a new address, such as after spam; people cannot replace their
 * own, so nobody gathers addresses. The old address is never issued again.
 */
export async function replaceInboundEmailAddress({
  runtime,
  owner,
}: {
  runtime: InboundEmailRuntime;
  owner: BackofficeUserContextScope;
}): Promise<{ address: string }> {
  const domain = runtime.config.inboundEmailDomain;
  if (domain === null) {
    throw new Error("This deployment has no inbound email domain (INBOUND_EMAIL_DOMAIN).");
  }
  const inbound = runtime.objects.inboundEmail.system().commands;
  const result = await claimRandomInboundAddress(domain, (address) =>
    inbound.replaceMailboxAddress(owner, address),
  );
  switch (result.status) {
    case "replaced":
      // A paused mailbox moves too, but stays disconnected until its owner sets it up again.
      return { address: result.mailbox.address };
    case "not-found":
      throw new Error("This person has no inbound address to replace.");
    case "invalid":
      throw new Error(`A generated inbound address is invalid: ${result.message}`);
    default:
      throw new Error("Inbound address replacement result is unsupported.", {
        cause: result satisfies never,
      });
  }
}

/**
 * Support stops a person's sending, such as after spam complaints, or resumes it. Their address
 * still receives either way.
 */
export async function setInboundEmailSending({
  runtime,
  owner,
  suspended,
}: {
  runtime: InboundEmailRuntime;
  owner: BackofficeUserContextScope;
  suspended: boolean;
}): Promise<void> {
  const inbound = runtime.objects.inboundEmail.system().commands;
  const result = suspended
    ? await inbound.suspendMailboxSending(owner)
    : await inbound.resumeMailboxSending(owner);
  if (result.status === "not-found") {
    throw new Error("This person has no inbound address.");
  }
}

/**
 * A person's one address at the inbound email domain, three random words registered with the
 * platform Resend account. It is theirs for good: disconnecting pauses it, and only support
 * replaces it.
 */
export function createEmailIntegration({
  runtime,
}: {
  runtime: InboundEmailRuntime;
}): IntegrationImplementation {
  function unavailableReason(context: IntegrationContext): string | null {
    if (context.execution.scope.kind !== "user") {
      return "Inbound email addresses belong to a person's own scope.";
    }
    if (runtime.config.inboundEmailDomain === null) {
      return "This deployment has no inbound email domain (INBOUND_EMAIL_DOMAIN).";
    }
    return runtime.config.bindings.resend ? null : "The Resend object binding is unavailable.";
  }

  function createMailboxAccess(context: IntegrationContext) {
    const reason = unavailableReason(context);
    const { scope } = context.execution;
    const domain = runtime.config.inboundEmailDomain;
    if (reason !== null || scope.kind !== "user" || domain === null) {
      throw new BackofficeUnavailableError(reason ?? "Inbound email is unavailable.");
    }
    const owner: BackofficeUserContextScope = scope;
    const inbound = runtime.objects.inboundEmail.system().commands;
    function invoke<T>(
      operation: BackofficePermissionRequirement,
      resource: Record<string, string>,
      execute: () => Promise<T>,
    ) {
      return context.kernel.invoke({
        execution: context.execution,
        operation,
        resource: { capabilityId: "resend", ...resource },
        execute,
      });
    }
    /** Refused once the person sent this month's emails. */
    async function admitSend() {
      const allowance = await checkUsageLimits(usageBillingForScope(runtime, owner), [
        MAILBOX_EMAIL_SENT_METER,
      ]);
      if (allowance.kind === "exhausted") {
        throw new BackofficeOperationError(
          "forbidden",
          `USAGE_LIMIT_EXCEEDED: ${allowance.message}`,
        );
      }
    }
    /** Read on each send, so a renamed person or a changed account email applies at once. */
    const profile = () =>
      runtime.objects.auth.singleton().commands.getAccountProfile({ userId: owner.userId });
    /** Recipients learn that Leyway sent it, and where to find out what Leyway is. */
    const withFooter = (text: string) => {
      const site = runtime.config.docsPublicBaseUrl;
      return `${text}\n\n-- \nSent with Leyway${site ? ` (${site})` : ""}.`;
    };
    async function readAttachments(
      attachments: readonly { path: string; filename?: string }[],
    ): Promise<ResendMailboxAttachmentInput[]> {
      if (attachments.length === 0) {
        return [];
      }
      await context.kernel.assertAuthorizedAll({
        execution: context.execution,
        requirements: attachments.map(({ path }) => ({
          operation: BACKOFFICE_PERMISSION.upload.read,
          resource: { path },
        })),
      });
      const state = createRuntimeStateBackend({
        runtime,
        kernel: context.kernel,
        execution: context.execution,
      });
      let remaining = MAX_MAILBOX_ATTACHMENT_BYTES;
      const read: ResendMailboxAttachmentInput[] = [];
      for (const { path, filename } of attachments) {
        let bytes: Uint8Array;
        try {
          bytes = await state.readFileBytes(path, remaining);
        } catch (error) {
          if (error instanceof StateFileReadLimitError) {
            throw new BackofficeOperationError(
              "invalid_request",
              `Attachments may hold at most ${MAX_MAILBOX_ATTACHMENT_BYTES} bytes together, and ${path} goes past that.`,
            );
          }
          throw error;
        }
        remaining -= bytes.length;
        read.push({
          filename: filename ?? path.slice(path.lastIndexOf("/") + 1),
          content: bytesToBase64(bytes),
        });
      }
      return read;
    }
    return {
      read: () =>
        invoke(BACKOFFICE_PERMISSION.connections.read, {}, () => inbound.getMailbox(owner)),
      /** Only the person's own verified account email can receive it. */
      sendToSelf: (input: z.output<typeof messageSendToSelfInputSchema>) =>
        invoke(BACKOFFICE_PERMISSION.integrations.execute, {}, async () => {
          await admitSend();
          const { name, email, emailVerified } = await profile();
          if (!emailVerified) {
            throw new BackofficeOperationError(
              "forbidden",
              "This person's account email is not verified, so nothing is sent to it.",
            );
          }
          const attachments = await readAttachments(input.attachments ?? []);
          return sentEmail(
            await inbound.sendFromMailbox(owner, {
              to: email,
              subject: input.subject,
              text: withFooter(input.text),
              fromName: senderName(name),
              attachments,
            }),
          );
        }),
      /** This month's emails against the person's limit; null without Billing. */
      sendingUsage: () =>
        invoke(BACKOFFICE_PERMISSION.connections.read, {}, async () => {
          if (!runtime.config.bindings.billing) {
            return null;
          }
          const { limits } = await runtime.objects.billing.for(owner).commands.getUsageLimits();
          const status = limits.find(({ meter }) => meter === MAILBOX_EMAIL_SENT_METER);
          return status
            ? {
                used: Number(status.used),
                limit: status.limit.kind === "limited" ? Number(status.limit.quantity) : null,
              }
            : null;
        }),
      /** The fragment replies only to a verified sender of email the person received. */
      reply: async (input: z.output<typeof messageReplyInputSchema>) => {
        try {
          return await invoke(
            BACKOFFICE_PERMISSION.email.send,
            { emailId: input.emailId },
            async () => {
              await admitSend();
              const { name } = await profile();
              return sentEmail(
                await inbound.replyFromMailbox(owner, {
                  emailMessageId: input.emailId,
                  text: withFooter(input.text),
                  subject: input.subject ?? null,
                  fromName: senderName(name),
                }),
                input.emailId,
              );
            },
          );
        } catch (error) {
          // Routes that read mail lack email.send unless granted it, so say which grant replies need.
          if (error instanceof BackofficeForbiddenError) {
            throw new BackofficeForbiddenError(
              `Replying needs the email.send permission: ${error.message}`,
              error.reason,
            );
          }
          throw error;
        }
      },
      /** Resumes the person's mailbox, or gives them one at a fresh address. */
      open: () =>
        invoke(BACKOFFICE_PERMISSION.connections.manage, {}, async () => {
          const result = await claimRandomInboundAddress(domain, (address) =>
            inbound.openMailbox(owner, address),
          );
          if (result.status === "invalid") {
            throw new Error(`A generated inbound address is invalid: ${result.message}`);
          }
          return result.mailbox;
        }),
      pause: () =>
        invoke(BACKOFFICE_PERMISSION.connections.manage, {}, async () => {
          await inbound.pauseMailbox(owner);
        }),
      /** Null unless the email arrived at one of the person's addresses, current or replaced. */
      message: (emailId: string) =>
        invoke(BACKOFFICE_PERMISSION.integrations.execute, { emailId }, () =>
          inbound.getMailboxEmail(owner, emailId),
        ),
      attachment: (emailId: string, attachmentId: string) =>
        invoke(BACKOFFICE_PERMISSION.integrations.execute, { emailId, attachmentId }, () =>
          inbound.getMailboxEmailAttachment(owner, emailId, attachmentId),
        ),
    };
  }

  /** Without the platform account, no address can receive email. */
  async function isPlatformAccountConfigured() {
    const config = await runtime.objects.resend.for({ kind: "system" }).commands.getAdminConfig();
    return config.configured;
  }

  async function setup(
    context: IntegrationContext,
    operation: IntegrationSetupOperation,
  ): Promise<IntegrationSetupProgress> {
    const connectionId = INBOUND_EMAIL_CONNECTION_ID;
    const reason = unavailableReason(context);
    if (reason !== null) {
      return { connectionId, status: "blocked", reason };
    }
    // Mailboxes live in the platform account, so none can be read before it is configured.
    if (!(await isPlatformAccountConfigured())) {
      return {
        connectionId,
        status: "blocked",
        reason: "The platform Resend account is not configured, so no address can receive email.",
      };
    }
    const access = createMailboxAccess(context);
    const mailbox = await access.read();
    if (mailbox !== null && !mailbox.paused) {
      return { connectionId, status: "ready" };
    }
    const domain = runtime.config.inboundEmailDomain;
    if (operation.kind === "check") {
      return {
        connectionId,
        status: "needs-input",
        instructions:
          mailbox === null
            ? `Submit {} to give this person their address at ${domain}: three random words, such as quiet-amber-falcon@${domain}. It is theirs for good; only support can replace it. Email sent or forwarded to it arrives as email.message.received events in their scope.`
            : `Submit {} to resume delivery to ${mailbox.address}.`,
        inputSchema: z.toJSONSchema(z.strictObject({}), { io: "input" }),
        secretFields: [],
      };
    }
    z.strictObject({}).parse(operation.input);
    await access.open();
    return { connectionId, status: "ready" };
  }

  return {
    connectionIds: [{ kind: "exact", connectionId: INBOUND_EMAIL_CONNECTION_ID }],
    setup: {
      kind: "supported",
      run: (context, { operation }) => setup(context, operation),
    },
    reconfigure: {
      kind: "unsupported",
      reason:
        "A person keeps one address for good, so nobody gathers addresses. To get a new one, such as after spam, they contact support.",
    },
    disconnect: {
      kind: "supported",
      async run(context) {
        const connectionId = INBOUND_EMAIL_CONNECTION_ID;
        const access = createMailboxAccess(context);
        const mailbox = await access.read();
        if (mailbox === null || mailbox.paused) {
          return { connectionId, status: "not-configured" };
        }
        await access.pause();
        return { connectionId, status: "disconnected" };
      },
    },
    async discover(context) {
      const reason = unavailableReason(context);
      const domain = runtime.config.inboundEmailDomain ?? "the inbound email domain";
      return [
        {
          id: emailIntegrationId,
          label: "Email address",
          description: `A person's own address at ${domain}, three random words such as quiet-amber-falcon@${domain}, that receives email, such as forwarded receipts, as email.message.received events. It also sends: replies to verified senders, and email to the person's own account email. It is theirs for good: disconnecting pauses delivery, setup resumes it, and only support replaces it.`,
          iconUrl: null,
          categories: [INTEGRATION_CATEGORY.communication],
          connectionCardinality: "singleton",
          availability:
            reason === null ? { status: "available" } : { status: "unavailable", reason },
          setupTargets: [{ kind: "connection", connectionId: INBOUND_EMAIL_CONNECTION_ID }],
          automationEvents: [
            { source: INBOUND_EMAIL_AUTOMATION_SOURCE, eventType: "message.received" },
          ],
        },
      ];
    },
    async list(context, cursor) {
      if (cursor !== null) {
        throw new Error("Email integration listing cursor is invalid.");
      }
      if (unavailableReason(context) !== null || !(await isPlatformAccountConfigured())) {
        return { connections: [], cursor: null };
      }
      const mailbox = await createMailboxAccess(context).read();
      return {
        connections:
          mailbox !== null && !mailbox.paused
            ? [
                {
                  connectionId: INBOUND_EMAIL_CONNECTION_ID,
                  integrationId: emailIntegrationId,
                  name: mailbox.address,
                  authMethod: "none" as const,
                  ...inspectMailbox(mailbox),
                  configuration: { status: "configured" as const },
                },
              ]
            : [],
        cursor: null,
      };
    },
    async resolve(context) {
      const access = createMailboxAccess(context);
      const mailbox = await access.read();
      async function inspect() {
        return inspectMailbox(await access.read());
      }
      /** Actions read only email that arrived at one of this person's addresses. */
      async function receivedEmail(emailId: string) {
        const email = await access.message(emailId);
        if (email === null) {
          throw new Error(`Email ${emailId} did not arrive at this person's address.`);
        }
        return email;
      }
      return {
        identity: {
          connectionId: INBOUND_EMAIL_CONNECTION_ID,
          integrationId: emailIntegrationId,
          name: mailbox?.address ?? "Email address",
          authMethod: "none",
        },
        inspect,
        async state(): Promise<IntegrationConnectionState> {
          const current = await access.read();
          return current !== null && !current.paused ? "ready" : "unavailable";
        },
        async details() {
          const current = await access.read();
          return {
            kind: "email",
            mailbox: current && {
              address: current.address,
              paused: current.paused,
              sendingSuspended: current.sendingSuspended,
            },
            sending: await access.sendingUsage(),
          };
        },
        async settings() {
          return null;
        },
        async actions() {
          return [
            {
              definition: messageGetActionDefinition(),
              async invoke(input) {
                const { emailId } = messageGetInputSchema.parse(input);
                const email = await receivedEmail(emailId);
                return messageGetOutputSchema.parse({
                  emailId: email.id,
                  address: email.recipientMailbox.address,
                  from: email.from,
                  senderAddress: email.from === null ? null : inboundEmailSenderAddress(email.from),
                  senderDomain: email.from === null ? null : inboundEmailSenderDomain(email.from),
                  senderVerified: inboundEmailSenderVerified(email.authentication),
                  authentication: email.authentication,
                  to: email.to,
                  cc: email.cc,
                  replyTo: email.replyTo,
                  subject: email.subject,
                  messageId: email.messageId,
                  inReplyTo: email.inReplyTo,
                  references: email.references,
                  text: email.text,
                  html: email.html,
                  headers: email.headers,
                  attachments: email.attachments.map(({ id, filename, contentType, size }) => ({
                    id,
                    filename,
                    contentType,
                    size,
                  })),
                  receivedAt: email.occurredAt,
                });
              },
            },
            {
              definition: messageSendToSelfActionDefinition(),
              async invoke(input) {
                return await access.sendToSelf(messageSendToSelfInputSchema.parse(input));
              },
            },
            {
              definition: messageReplyActionDefinition(),
              async invoke(input) {
                return await access.reply(messageReplyInputSchema.parse(input));
              },
            },
            {
              definition: attachmentGetActionDefinition(),
              async invoke(input) {
                const { emailId, attachmentId } = attachmentGetInputSchema.parse(input);
                await receivedEmail(emailId);
                const attachment = await access.attachment(emailId, attachmentId);
                if (attachment === null) {
                  throw new Error(`Email ${emailId} has no attachment ${attachmentId}.`);
                }
                return attachmentGetOutputSchema.parse(attachment);
              },
            },
          ];
        },
        // Registration is the whole configuration; there is nothing live to check.
        verify: inspect,
      };
    },
  };
}
