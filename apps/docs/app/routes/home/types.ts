export type PerspectiveAudience = "authors" | "users" | "both";
export type PerspectiveTime = "low" | "medium" | "high";

export type PerspectiveState = {
  audience: PerspectiveAudience;
  time: PerspectiveTime;
};

export const defaultPerspective: PerspectiveState = {
  audience: "both",
  time: "high",
};

export type NewsletterActionData = {
  intent: "newsletter";
  success?: boolean;
  message?: string;
};

export type PerspectiveActionData = {
  intent: "perspective";
  perspective: PerspectiveState;
};

export type HomeActionData = NewsletterActionData | PerspectiveActionData;
