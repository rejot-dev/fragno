import type {
  AutomationForwardAccept,
  AutomationForwardSenders,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  type BackofficeContextScope,
  backofficeScopeReferenceCodec,
  backofficeScopeRootOwner,
  formatBackofficeScopeSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { evaluateAutomationEventMatcher } from "./routing";

/** Names a scope by its IDs alone: where its objects are kept does not change which scope it is. */
function scopeIdentity(scope: BackofficeContextScope): string {
  return formatBackofficeScopeSegment(scope, backofficeScopeReferenceCodec);
}

/**
 * Whether a forward from `from` into `to` needs one of `to`'s accepts. System, and the scopes of
 * the receiving scope's own owner, forward without one: that owner already answers for both ends.
 */
export function forwardNeedsAccept(from: BackofficeContextScope, to: BackofficeContextScope) {
  const sender = backofficeScopeRootOwner(from);
  const receiver = backofficeScopeRootOwner(to);
  return (
    sender !== null && (receiver === null || scopeIdentity(sender) !== scopeIdentity(receiver))
  );
}

/** `members` names the personal scopes of an organization's members, so only its scopes take it. */
export function forwardSendersFitScope(
  senders: AutomationForwardSenders,
  scope: BackofficeContextScope,
): boolean {
  return senders.kind !== "members" || backofficeScopeRootOwner(scope)?.kind === "org";
}

/**
 * Whether `accept` names `from` as a sender and its matcher lets `event` through, enabled or not.
 * That a personal scope's owner is a member is for the forwarding scope to prove: it may only
 * forward into an organization its owner may emit events in.
 */
export function forwardAcceptLetsIn(
  accept: AutomationForwardAccept,
  event: AutomationEvent,
  from: BackofficeContextScope,
): boolean {
  return (
    (accept.from.kind === "members"
      ? from.kind === "user"
      : scopeIdentity(accept.from.scope) === scopeIdentity(from)) &&
    evaluateAutomationEventMatcher(accept.matcher, event)
  );
}

/** Whether an enabled accept takes in `event`, forwarded from `from`. */
export function forwardAccepted(
  accepts: readonly AutomationForwardAccept[],
  event: AutomationEvent,
  from: BackofficeContextScope,
): boolean {
  return accepts.some((accept) => accept.enabled && forwardAcceptLetsIn(accept, event, from));
}
