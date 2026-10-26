import { backofficeJurisdictionSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

/** The workflow that onboards a person; each person's instance is named by their user ID. */
export const ONBOARDING_WORKFLOW_NAME = "backoffice-onboarding";

const organizationNameSchema = z.string().trim().min(1).max(100);

/**
 * Every question onboarding may ask, each answered on a page of its own by one event its workflow
 * waits for. Which ones a person is asked follows from their earlier answers; the client questions
 * repeat, once for each client.
 */
export const ONBOARDING_QUESTIONS = {
  /** On their own, for one organization, or as an agency for its client organizations. */
  usage: {
    event: "onboarding.usage",
    schema: z.strictObject({ usage: z.enum(["personal", "organization", "agency"]) }),
  },
  /** Where the person's Durable Objects, and those of every organization they set up, are kept. */
  jurisdiction: {
    event: "onboarding.jurisdiction",
    schema: z.strictObject({ jurisdiction: backofficeJurisdictionSchema.nullable() }),
  },
  "organization-name": {
    event: "onboarding.organization-name",
    schema: z.strictObject({ name: organizationNameSchema }),
  },
  "agency-name": {
    event: "onboarding.agency-name",
    schema: z.strictObject({ name: organizationNameSchema }),
  },
  /** The next client the agency manages, which onboarding creates before asking anything else. */
  "client-name": {
    event: "onboarding.client-name",
    schema: z.strictObject({ name: organizationNameSchema }),
  },
  /** Whether the agency adds another client or finishes. */
  "more-clients": {
    event: "onboarding.more-clients",
    schema: z.strictObject({ more: z.boolean() }),
  },
} as const;

export type OnboardingQuestion = keyof typeof ONBOARDING_QUESTIONS;

export type OnboardingAnswerTo<TQuestion extends OnboardingQuestion> = z.output<
  (typeof ONBOARDING_QUESTIONS)[TQuestion]["schema"]
>;

/** One answer, as the onboarding page submits it. */
export type OnboardingAnswer = {
  [TQuestion in OnboardingQuestion]: {
    question: TQuestion;
    answer: OnboardingAnswerTo<TQuestion>;
  };
}[OnboardingQuestion];

/**
 * The question onboarding asks now. The agency's client questions say which client they are about:
 * the next one's number, or the clients created so far.
 */
export type OnboardingPrompt =
  | { question: "usage" | "jurisdiction" | "organization-name" | "agency-name" }
  | { question: "client-name"; client: number }
  | { question: "more-clients"; clients: string[] };

/** Where a person's onboarding stands, as its workflow instance records it. */
export type UserOnboardingState =
  | { status: "asking"; prompt: OnboardingPrompt }
  | { status: "setting-up" }
  | { status: "complete" }
  | { status: "failed"; message: string };
