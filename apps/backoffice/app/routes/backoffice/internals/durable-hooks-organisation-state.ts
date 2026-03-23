export type DurableHooksOrgFragment =
  | "cloudflare"
  | "telegram"
  | "otp"
  | "resend"
  | "github"
  | "upload"
  | "automations"
  | "pi";

export const DURABLE_HOOK_ORG_FRAGMENTS = [
  "cloudflare",
  "telegram",
  "otp",
  "resend",
  "github",
  "upload",
  "automations",
  "pi",
] as const satisfies DurableHooksOrgFragment[];

export const FRAGMENT_LABELS: Record<DurableHooksOrgFragment, string> = {
  cloudflare: "Cloudflare Workers",
  telegram: "Telegram",
  otp: "OTP",
  resend: "Resend",
  github: "GitHub",
  upload: "Upload",
  pi: "Pi",
  automations: "Automations",
};

export const FRAGMENT_CONFIGURE_META: Record<
  DurableHooksOrgFragment,
  {
    path: (orgId: string) => string;
    label: string;
  }
> = {
  cloudflare: {
    path: () => "/backoffice/environments/workers",
    label: "Open Workers control plane",
  },
  telegram: {
    path: (orgId) => `/backoffice/connections/telegram/${orgId}/configuration`,
    label: "Configure Telegram",
  },
  otp: {
    path: (orgId) => `/backoffice/connections/telegram/${orgId}/configuration`,
    label: "Open Telegram linking",
  },
  resend: {
    path: (orgId) => `/backoffice/connections/resend/${orgId}/configuration`,
    label: "Configure Resend",
  },
  github: {
    path: (orgId) => `/backoffice/connections/github/${orgId}/configuration`,
    label: "Configure GitHub",
  },
  upload: {
    path: (orgId) => `/backoffice/connections/upload/${orgId}/configuration`,
    label: "Configure Upload",
  },
  pi: {
    path: (orgId) => `/backoffice/sessions/${orgId}/configuration`,
    label: "Configure Pi",
  },
  automations: {
    path: (orgId) => `/backoffice/internals/durable-hooks/${orgId}`,
    label: "Open Automations runtime",
  },
};

export const isDurableHookOrgFragment = (
  value: string | null | undefined,
): value is DurableHooksOrgFragment =>
  Boolean(
    value &&
    DURABLE_HOOK_ORG_FRAGMENTS.includes(value as (typeof DURABLE_HOOK_ORG_FRAGMENTS)[number]),
  );

type ErrorLogger = (message?: unknown, ...optionalParams: unknown[]) => void;

export const getDurableHooksLoaderErrorMessage = ({
  fragment,
  orgId,
  error,
  logError = console.error,
}: {
  fragment: DurableHooksOrgFragment;
  orgId: string;
  error: unknown;
  logError?: ErrorLogger;
}) => {
  const fragmentLabel = FRAGMENT_LABELS[fragment];

  logError(`Failed to load ${fragmentLabel} durable hooks`, {
    fragment,
    orgId,
    error,
  });

  if (fragment === "upload") {
    return "Upload service unavailable";
  }

  return `Failed to load ${fragmentLabel} durable hooks.`;
};
