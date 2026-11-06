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
import type { ResendMailbox } from "@fragno-dev/resend-fragment";

import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  INBOUND_EMAIL_AUTOMATION_SOURCE,
  inboundEmailReceivedPayloadSchema,
} from "@/fragno/backoffice-capabilities/capabilities/resend";
import {
  INBOUND_EMAIL_CONNECTION_ID,
  inboundEmailOwnerScope,
  inboundEmailSenderDomain,
  inboundEmailSenderVerified,
} from "@/fragno/inbound-email";
import { claimRandomInboundAddress } from "@/fragno/inbound-email-address";

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
    return {
      read: () =>
        invoke(BACKOFFICE_PERMISSION.connections.read, {}, () => inbound.getMailbox(owner)),
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
          description: `A person's own address at ${domain}, three random words such as quiet-amber-falcon@${domain}, that receives email, such as forwarded receipts, as email.message.received events. It is theirs for good: disconnecting pauses delivery, setup resumes it, and only support replaces it.`,
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
            mailbox: current && { address: current.address, paused: current.paused },
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
