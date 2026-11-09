import { CopyButton } from "@fragno-private/design-system/controls/copy-button";

import type { IntegrationConnectionDetails } from "@/fragno/runtime-tools/families/integrations/integration-implementation";

import { DetailSection } from "./connection-display";

/** People open this to copy the address into a forwarding rule, so the address leads. */
export function EmailConnectionDetails({
  details,
}: {
  details: Extract<IntegrationConnectionDetails, { kind: "email" }>;
}) {
  const { mailbox, sending } = details;
  return (
    <DetailSection title="Email address">
      {mailbox === null ? (
        <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
          No address yet. Ask your agent to set one up.
        </p>
      ) : (
        <div className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-sm font-semibold text-[var(--bo-fg)]">
              {mailbox.address}
            </span>
            <CopyButton value={mailbox.address} label="Copy address" text="Copy" />
          </div>
          <p className="text-xs text-[var(--bo-muted)]">
            {mailbox.paused
              ? "Delivery is paused, and email sent here reaches no one. The address stays yours: ask your agent to set it up again to resume."
              : "Forward or send email here. Each email arrives as an email message.received event in this scope, where your automations act on it."}
          </p>
          {mailbox.paused ? null : (
            <p className="text-xs text-[var(--bo-muted)]">
              {mailbox.sendingSuspended
                ? "Sending is suspended, such as after a recipient marked an email from it as spam. It still receives; contact support to send again."
                : `It also sends replies to verified senders, and email to your own account email${
                    sending === null
                      ? "."
                      : `: ${sending.used} of ${sending.limit ?? "unlimited"} this month.`
                  }`}
            </p>
          )}
        </div>
      )}
    </DetailSection>
  );
}
