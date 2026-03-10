export type DurableHooksOrgFragment = "telegram" | "resend" | "github" | "upload";

export const FRAGMENT_LABELS: Record<DurableHooksOrgFragment, string> = {
  telegram: "Telegram",
  resend: "Resend",
  github: "GitHub",
  upload: "Upload",
};

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
