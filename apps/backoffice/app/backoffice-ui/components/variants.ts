import { z } from "zod";

export const BACKOFFICE_UI_VARIANTS = ["neutral", "accent", "live", "warning", "failed"] as const;

export type BackofficeUiVariant = (typeof BACKOFFICE_UI_VARIANTS)[number];

export const backofficeUiVariantSchema = z.enum(BACKOFFICE_UI_VARIANTS);

export const backofficeUiVariantClasses = {
  neutral: "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]",
  accent: "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]",
  live: "border-[color:var(--bo-live)] bg-[var(--bo-live-bg)] text-[var(--bo-live)]",
  warning: "border-[color:var(--bo-waiting)] bg-[var(--bo-waiting-bg)] text-[var(--bo-waiting)]",
  failed: "border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] text-[var(--bo-failed)]",
} satisfies Record<BackofficeUiVariant, string>;
