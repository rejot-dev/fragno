import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { jsonValueSchema } from "./shared/json";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

// Question names become the classifier's wire names, so they stay identifier-shaped.
const questionNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u, {
  message: "Question names start with a letter and contain only letters, digits, and underscores.",
});

const classifierQuestionSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("choice"),
      instructions: z.string().trim().min(1),
      criteria: z
        .record(z.string().trim().min(1), z.string())
        .refine((criteria) => Object.keys(criteria).length >= 2, {
          message: "A choice question needs at least two options.",
        })
        .describe("Each option's value mapped to when it applies."),
    }),
    z.strictObject({
      type: z.literal("score"),
      instructions: z.string().trim().min(1),
      criteria: z
        .array(z.string().trim().min(1))
        .min(2)
        .describe("Ordered levels from lowest to highest; the score is a 0-based level index."),
    }),
    z.strictObject({
      type: z.literal("bool"),
      instructions: z.string().trim().min(1),
      criteria: z.strictObject({ true: z.string(), false: z.string() }),
    }),
  ]),
);

const modelsClassifyInputSchema = z.lazy(() =>
  z.strictObject({
    state: z
      .record(z.string(), jsonValueSchema)
      .describe("The evidence every question is answered about."),
    questions: z
      .record(questionNameSchema, classifierQuestionSchema)
      .refine((questions) => Object.keys(questions).length > 0, {
        message: "Ask at least one question.",
      }),
  }),
);

const classifierAnswerSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()),
      confidence: z.number(),
    }),
    z.object({
      type: z.literal("score"),
      score: z.number().describe("Probability-weighted level index; may fall between levels."),
      confidence: z.number(),
    }),
    z.object({
      type: z.literal("bool"),
      probability: z.number().describe("Probability that the condition is true."),
    }),
  ]),
);

const modelsClassifyOutputSchema = z.lazy(() =>
  z.object({
    answers: z
      .record(z.string(), classifierAnswerSchema)
      .describe("One answer per question, keyed by question name."),
  }),
);

export const modelsOperations = {
  "models.classify": {
    description:
      "Answer typed questions about JSON state with a fast classifier model. A `choice` question " +
      "picks one option with probabilities, a `score` question rates against ordered levels, and " +
      "a `bool` question returns the probability that a condition holds. Use it for routing, " +
      "triage, and filtering; it does not generate text. Independent questions about the same " +
      "state belong in one call. Each call is billed by input tokens.",
    permissions: [BACKOFFICE_PERMISSION.models.classify],
    input: modelsClassifyInputSchema,
    output: modelsClassifyOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
