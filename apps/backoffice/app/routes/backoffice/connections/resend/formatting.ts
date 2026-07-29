import type { ResendDomain } from "@fragno-dev/resend-fragment";

export const getResendDomainStatusTone = (status: ResendDomain["status"]) => {
  switch (status) {
    case "verified":
      return "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]";
    case "failed":
    case "temporary_failure":
      return "border-red-500/40 bg-red-500/10 text-red-300";
    case "not_started":
    case "partially_failed":
    case "partially_verified":
    case "pending":
      return "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
  }

  throw new Error("Unsupported Resend domain status.");
};

export const formatResendDomainStatus = (status: ResendDomain["status"]) =>
  status.replace(/_/g, " ");

export const formatResendCapability = (value: ResendDomain["capabilities"]["sending"]) =>
  value === "enabled" ? "Enabled" : "Disabled";
