import {
  backofficeScopePathSegment,
  parseBackofficeScopePathSegment,
  type BackofficeUserContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { z } from "zod";

import type { ResendMailboxEmail } from "@fragno-dev/resend-fragment";

import type { AutomationKnownEvent } from "./automation/contracts";
import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./automation/contracts";
import {
  INBOUND_EMAIL_MAX_EVENT_TEXT_LENGTH,
  inboundEmailSenderEntity,
  type inboundEmailReceivedPayloadSchema,
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
