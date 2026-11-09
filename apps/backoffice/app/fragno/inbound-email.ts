import {
  backofficeScopePathSegment,
  parseBackofficeScopePathSegment,
  type BackofficeUserContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { z } from "zod";

import {
  isSenderVerified,
  type ResendEmailAuthentication,
  type ResendEmailStatusUpdatedHookPayload,
  type ResendMailboxEmail,
  type ResendMailboxMatch,
} from "@fragno-dev/resend-fragment";

import { AUTOMATION_SYSTEM_INITIATOR } from "./automation/actors";
import type { AutomationKnownEvent } from "./automation/contracts";
import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./automation/contracts";
import {
  INBOUND_EMAIL_MAX_EVENT_TEXT_LENGTH,
  inboundEmailSenderEntity,
  type inboundEmailReceivedPayloadSchema,
  type mailboxEmailStatusPayloadSchema,
} from "./backoffice-capabilities/capabilities/resend";

/** The Resend fragment's opaque owner of an inbound address: the user scope it delivers to. */
export function inboundEmailOwner(scope: BackofficeUserContextScope): string {
  return backofficeScopePathSegment(scope);
}

/** Reads an owner Backoffice registered, so anything but a user scope is a bug. */
export function inboundEmailOwnerScope(owner: string): BackofficeUserContextScope {
  const scope = parseBackofficeScopePathSegment(owner);
  if (scope.kind !== "user") {
    throw new Error(`Inbound address owner ${owner} is not a user scope.`);
  }
  return scope;
}

/** A person's inbound address, whichever it is now, in their own scope. */
export const INBOUND_EMAIL_CONNECTION_ID = "backoffice#email";

/** The mailbox of a From header such as `Shop <orders@shop.example>`, lowercased. */
function senderMailbox(from: string): string {
  return (/<([^<>]+)>\s*$/u.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** A From header's address, lowercased; null when it names no address. */
export function inboundEmailSenderAddress(from: string): string | null {
  const mailbox = senderMailbox(from);
  const at = mailbox.lastIndexOf("@");
  return at > 0 && at < mailbox.length - 1 ? mailbox : null;
}

/** The domain of a From header's mailbox, lowercased; null when it names no address. */
export function inboundEmailSenderDomain(from: string): string | null {
  const address = inboundEmailSenderAddress(from);
  return address === null ? null : address.slice(address.lastIndexOf("@") + 1);
}

/** Whether the From domain sent the email, as the Resend fragment decides it before a reply. */
export function inboundEmailSenderVerified(authentication: ResendEmailAuthentication | null) {
  return isSenderVerified(authentication);
}

/** One event per received message, in the scope of the user whose address it arrived at. */
export function buildInboundEmailAutomationEvent(
  scope: BackofficeUserContextScope,
  email: ResendMailboxEmail,
): AutomationKnownEvent<typeof AUTOMATION_SOURCES.email> {
  const { from, text } = email;
  // Resend stores a From header for every received email.
  if (from === null) {
    throw new Error(`Received email ${email.id} has no From header.`);
  }
  const payload: z.input<typeof inboundEmailReceivedPayloadSchema> = {
    emailId: email.id,
    connectionId: INBOUND_EMAIL_CONNECTION_ID,
    address: email.recipientMailbox.address,
    from,
    senderAddress: inboundEmailSenderAddress(from),
    senderDomain: inboundEmailSenderDomain(from),
    senderVerified: inboundEmailSenderVerified(email.authentication),
    authentication: email.authentication,
    to: email.to,
    cc: email.cc,
    replyTo: email.replyTo,
    subject: email.subject,
    messageId: email.messageId,
    text: text === null ? null : text.slice(0, INBOUND_EMAIL_MAX_EVENT_TEXT_LENGTH),
    textTruncated: text !== null && text.length > INBOUND_EMAIL_MAX_EVENT_TEXT_LENGTH,
    attachments: email.attachments.map(({ id, filename, contentType, size }) => ({
      id,
      filename,
      contentType,
      size,
    })),
    receivedAt: email.occurredAt.toISOString(),
  };
  return {
    id: `email:${email.id}`,
    scopeRestriction: null,
    scope,
    source: AUTOMATION_SOURCES.email,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.email.messageReceived,
    occurredAt: payload.receivedAt,
    payload,
    actors: {
      // Anyone can write any From address, so the sender stays an external address.
      initiator: {
        scope: "external",
        source: AUTOMATION_SOURCES.email,
        type: inboundEmailSenderEntity.type,
        id: senderMailbox(from),
        role: "initiator",
      },
      principal: null,
      delegation: [],
    },
    causation: { kind: "origin" },
  };
}

const MAILBOX_EMAIL_STATUS_EVENT_TYPES = {
  "email.delivered": AUTOMATION_SOURCE_EVENT_TYPES.email.messageDelivered,
  "email.bounced": AUTOMATION_SOURCE_EVENT_TYPES.email.messageBounced,
  "email.complained": AUTOMATION_SOURCE_EVENT_TYPES.email.messageComplained,
} as const;

/**
 * What became of an email a person sent from their address, in their scope; null for the statuses
 * people do not act on, such as Resend accepting it.
 */
export function buildMailboxEmailStatusAutomationEvent(
  scope: BackofficeUserContextScope,
  {
    emailMessageId,
    event,
    senderMailbox,
  }: Pick<ResendEmailStatusUpdatedHookPayload, "emailMessageId" | "event"> & {
    senderMailbox: ResendMailboxMatch;
  },
): AutomationKnownEvent<typeof AUTOMATION_SOURCES.email> | null {
  if (
    event.type !== "email.delivered" &&
    event.type !== "email.bounced" &&
    event.type !== "email.complained"
  ) {
    return null;
  }
  const eventType = MAILBOX_EMAIL_STATUS_EVENT_TYPES[event.type];
  const payload: z.input<typeof mailboxEmailStatusPayloadSchema> = {
    emailId: emailMessageId,
    connectionId: INBOUND_EMAIL_CONNECTION_ID,
    address: senderMailbox.address,
    to: event.data.to,
    subject: event.data.subject ?? null,
    reason: event.type === "email.bounced" ? (event.data.bounce?.message ?? null) : null,
    occurredAt: new Date(event.created_at).toISOString(),
  };
  return {
    id: `email:${emailMessageId}:${eventType}`,
    scopeRestriction: null,
    scope,
    source: AUTOMATION_SOURCES.email,
    eventType,
    occurredAt: payload.occurredAt,
    payload,
    actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
    causation: { kind: "origin" },
  };
}
