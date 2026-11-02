export const BACKOFFICE_STATUS_TONES = ["info", "live", "waiting", "failed", "muted"] as const;

export type BackofficeStatusTone = (typeof BACKOFFICE_STATUS_TONES)[number];
