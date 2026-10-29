import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";

import type { AccessCodeStatus } from "@/fragno/access-codes/contracts";

export const ACCESS_CODE_STATUS_DISPLAY = {
  active: { label: "Active", tone: "live" },
  expired: { label: "Expired", tone: "muted" },
  revoked: { label: "Revoked", tone: "failed" },
} as const satisfies Record<AccessCodeStatus, { label: string; tone: BackofficeStatusTone }>;

// A fixed time zone renders the same on the server and in the browser.
const ACCESS_CODE_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function formatAccessCodeDate(value: string) {
  return ACCESS_CODE_DATE_FORMATTER.format(new Date(value));
}
