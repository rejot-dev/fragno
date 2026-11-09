import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { AutomationExternalEntityDefinition } from "@/fragno/automation/contracts";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

/** Mail users receive at their inbound addresses, through the platform Resend account. */
export const INBOUND_EMAIL_AUTOMATION_SOURCE = "email" as const;
export const INBOUND_EMAIL_AUTOMATION_EVENT_MESSAGE_RECEIVED = "message.received" as const;
/** What became of email a person sent from their address, by the receiving server's account. */
export const MAILBOX_EMAIL_STATUS_AUTOMATION_EVENTS = {
  delivered: {
    eventType: "message.delivered",
    label: "Email delivered",
    description: "The receiving server accepted an email the person sent from their address.",
  },
  bounced: {
    eventType: "message.bounced",
    label: "Email bounced",
    description:
      "The receiving server refused an email the person sent from their address; reason says why.",
  },
  complained: {
    eventType: "message.complained",
    label: "Email marked as spam",
    description:
      "The recipient marked an email the person sent as spam. Sending from the address stops until support resumes it.",
  },
} as const;
// Events keep a bounded body; message.get reads the whole message.
export const INBOUND_EMAIL_MAX_EVENT_TEXT_LENGTH = 16_000;

export const inboundEmailSenderEntity = {
  scope: "external",
  source: INBOUND_EMAIL_AUTOMATION_SOURCE,
  type: "sender",
  label: "Email sender",
  description:
    "The address in a received email's From header. Anyone can write any From address, so a sender never links to a Backoffice user.",
} as const satisfies AutomationExternalEntityDefinition<typeof INBOUND_EMAIL_AUTOMATION_SOURCE>;

const inboundEmailAuthenticationResultSchema = z.enum([
  "pass",
  "fail",
  "gray",
  "processing_failed",
  "unknown",
]);

export const inboundEmailReceivedPayloadSchema = z.object({
  emailId: z
    .string()
    .min(1)
    .describe("The received email; message.get and attachment.get on connectionId take it."),
  connectionId: z
    .string()
    .min(1)
    .describe("backoffice#email, the person's address; message.get and attachment.get run on it."),
  address: z
    .string()
    .min(1)
    .describe("The address it arrived at, which may since have been replaced."),
  from: z.string().describe("The From header, e.g. Shop <orders@shop.example>."),
  senderAddress: z
    .string()
    .nullable()
    .describe(
      "The From address alone, lowercased, such as orders@shop.example; null when From names no address. Every Leyway address sends as ley.run, so match a Leyway sender here, never by senderDomain.",
    ),
  senderDomain: z
    .string()
    .nullable()
    .describe(
      "The From address's domain, lowercased, such as shop.example; null when From names no address. Match it with eq: includes also matches shop.example.attacker.test.",
    ),
  senderVerified: z
    .boolean()
    .describe(
      "Whether senderDomain sent this email: Resend's DKIM or DMARC check passed. It proves the domain, not the person, and says nothing about the content.",
    ),
  authentication: z
    .object({
      spf: inboundEmailAuthenticationResultSchema,
      dkim: inboundEmailAuthenticationResultSchema,
      dmarc: inboundEmailAuthenticationResultSchema,
    })
    .nullable()
    .describe(
      "Resend's SPF, DKIM and DMARC results, computed on receipt, so a sender cannot forge them. gray is neither pass nor fail, such as a domain without an enforcing DMARC policy. Null when Resend reported none.",
    ),
  to: z
    .array(z.string())
    .describe(
      "The To header. A forwarded email names its original recipients here, not the address.",
    ),
  cc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string().nullable(),
  messageId: z.string().nullable().describe("The Message-ID header."),
  text: z
    .string()
    .nullable()
    .describe(
      `Plain-text body, at most ${INBOUND_EMAIL_MAX_EVENT_TEXT_LENGTH} characters; null for HTML-only email.`,
    ),
  textTruncated: z.boolean().describe("Whether text was cut short; message.get reads all of it."),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        filename: z.string().nullable(),
        contentType: z.string(),
        size: z.number().int().nonnegative(),
      }),
    )
    .describe("Attachments as metadata; attachment.get returns a download URL for each id."),
  receivedAt: z.iso.datetime(),
});

export const mailboxEmailStatusPayloadSchema = z.object({
  emailId: z
    .string()
    .min(1)
    .describe("The sent email, as message.reply or message.sendToSelf returned it."),
  connectionId: z.string().min(1).describe("backoffice#email, the person's address."),
  address: z.string().min(1).describe("The address it was sent from."),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  reason: z
    .string()
    .nullable()
    .describe("Why the receiving server refused a bounced email; null for other events."),
  occurredAt: z.iso.datetime(),
});

export const inboundEmailReceivedActorSchema = z.object({
  scope: z.literal("external"),
  source: z.literal(INBOUND_EMAIL_AUTOMATION_SOURCE),
  type: z.literal(inboundEmailSenderEntity.type),
  id: z.string().min(1).describe("The From address, lowercased."),
  role: z.literal("initiator"),
});

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const requiredHttpUrl = z
  .string()
  .trim()
  .min(1, "Webhook base URL is required.")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Webhook base URL must include http:// or https://." },
  );

export const resendConfigureInputSchema = z.object({
  apiKey: optionalTrimmedString,
  defaultFrom: optionalTrimmedString,
  defaultReplyTo: z.union([z.string(), z.array(z.string())]).optional(),
  webhookBaseUrl: requiredHttpUrl,
});

const connectionStatusIdentity = {
  id: "resend",
  label: "Resend",
  kind: "connection",
} as const;
const getResendDo = (
  objects: BackofficeObjectRegistry,
  organization: BackofficeOrganizationContextScope,
) => objects.resend.for(organization);

type ResendAdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
};

const toResendStatus = (response: ResendAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...connectionStatusIdentity,
      configured: false,
      missing: ["apiKey", "defaultFrom", "webhookBaseUrl", "webhookSecret"],
    };
  }

  return {
    ...connectionStatusIdentity,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const resendCapability: BackofficeCapability = {
  id: connectionStatusIdentity.id,
  label: connectionStatusIdentity.label,
  objectBinding: null,
  contributions: {
    connection: {
      getStatus: async ({ objects, organization }) =>
        toResendStatus(await getResendDo(objects, organization).commands.getAdminConfig()),
    },
    eventSources: [
      {
        source: INBOUND_EMAIL_AUTOMATION_SOURCE,
        label: "Email",
        description:
          "Email received at a person's inbound address, such as forwarded receipts, and what became of email they sent from it.",
      },
    ],
    actionProviders: ["integrations"],
    hookScopes: [
      {
        id: "resend",
        label: "Resend",
        getRepository: ({ objects, organization }) =>
          createDurableHookRepositoryFromCommands(getResendDo(objects, organization).commands),
      },
    ],
    skillPaths: ["skills/receiving-email/SKILL.md", "skills/sending-email/SKILL.md"],
    externalEntities: [inboundEmailSenderEntity],
    automationEvents: [
      {
        source: INBOUND_EMAIL_AUTOMATION_SOURCE,
        eventType: INBOUND_EMAIL_AUTOMATION_EVENT_MESSAGE_RECEIVED,
        label: "Email received",
        description:
          "An email arrived at the person's inbound address, recorded in their personal scope. Forwarded email names the person who forwarded it in From only when they forwarded it by hand.",
        payloadSchema: inboundEmailReceivedPayloadSchema,
        actorSchema: inboundEmailReceivedActorSchema,
        example: {
          emailId: "0198f6e2-7c41-7000-8000-000000000001",
          connectionId: "backoffice#email",
          address: "quiet-amber-falcon@ley.run",
          from: "Shop <orders@shop.example>",
          senderAddress: "orders@shop.example",
          senderDomain: "shop.example",
          senderVerified: true,
          authentication: { spf: "fail", dkim: "pass", dmarc: "pass" },
          to: ["me@mail.example"],
          cc: [],
          replyTo: [],
          subject: "Fwd: Your receipt",
          messageId: "<receipt-1@shop.example>",
          text: "Total: 12.00 EUR",
          textTruncated: false,
          attachments: [
            { id: "att_1", filename: "receipt.pdf", contentType: "application/pdf", size: 48213 },
          ],
          receivedAt: "2026-11-04T09:00:00.000Z",
        },
      },
      ...Object.values(MAILBOX_EMAIL_STATUS_AUTOMATION_EVENTS).map(
        ({ eventType, label, description }) => ({
          source: INBOUND_EMAIL_AUTOMATION_SOURCE,
          eventType,
          label,
          description,
          payloadSchema: mailboxEmailStatusPayloadSchema,
          example: {
            emailId: "0198f6e2-7c41-7000-8000-000000000002",
            connectionId: "backoffice#email",
            address: "quiet-amber-falcon@ley.run",
            to: ["orders@shop.example"],
            subject: "Re: Your order",
            reason: eventType === "message.bounced" ? "Mailbox does not exist" : null,
            occurredAt: "2026-11-04T09:05:00.000Z",
          },
        }),
      ),
    ],
  },
};
