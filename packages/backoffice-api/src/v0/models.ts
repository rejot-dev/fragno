import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { blobKeySchema } from "./blobs";
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

/** Raw image budgets, before base64 expansion and provider request serialization. */
export const MODELS_CLASSIFY_IMAGE_LIMITS = {
  count: 128,
  perImageBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
} as const;

const workspaceFilePathSchema = z
  .string()
  .trim()
  .refine(
    (path) =>
      (path.startsWith("/workspace/") || path.startsWith("/shared/")) &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    {
      message:
        "Files use absolute file paths under /workspace or /shared without traversal segments.",
    },
  );

/** A file a model reads: a workspace file by its path, or one of the scope's blobs by its key. */
const modelsFileSchema = z.lazy(() =>
  z.union([
    z.strictObject({ path: workspaceFilePathSchema }),
    z.strictObject({ blob: blobKeySchema }),
  ]),
);

export type ModelsFile = z.output<typeof modelsFileSchema>;

const modelsClassifyInputSchema = z.lazy(() =>
  z.strictObject({
    state: z
      .record(z.string(), jsonValueSchema)
      .describe("The evidence every question is answered about."),
    images: z
      .array(modelsFileSchema)
      .max(MODELS_CLASSIFY_IMAGE_LIMITS.count)
      .default([])
      .describe(
        "Ordered images judged together with state, each a workspace file `{ path }` or a blob " +
          "`{ blob }` by key; requires upload.read for each. Blobs hold images too large for " +
          `the workspace. Up to ${MODELS_CLASSIFY_IMAGE_LIMITS.count} PNG, JPEG, or WebP images; at most ` +
          `${MODELS_CLASSIFY_IMAGE_LIMITS.perImageBytes / 1024 ** 2} MiB ` +
          `per image and ${MODELS_CLASSIFY_IMAGE_LIMITS.totalBytes / 1024 ** 2} MiB total.`,
      ),
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

const modelsGenerateImageInputSchema = z.lazy(() =>
  z.strictObject({
    prompt: z.string().trim().min(1).max(32_000).describe("What the image shows and how."),
    out: z
      .string()
      .trim()
      .regex(/\.(png|jpe?g|webp)$/iu, {
        message: "The image path ends in .png, .jpg, .jpeg, or .webp.",
      })
      .describe(
        "Absolute path of the image to write under /workspace. Its extension picks the format.",
      ),
    size: z
      .enum(["auto", "1024x1024", "1536x1024", "1024x1536"])
      .default("auto")
      .describe("Square, landscape, or portrait; `auto` lets the model choose from the prompt."),
    quality: z
      .enum(["auto", "low", "medium", "high", "xhigh", "max"])
      .default("auto")
      .describe("Higher quality takes longer and costs more; `low` suits drafts."),
  }),
);

const modelsGenerateImageOutputSchema = z.lazy(() =>
  z.object({
    path: z.string().describe("Where the image was written."),
  }),
);

/** Raw file budgets, before base64 expansion and provider request serialization. */
export const MODELS_EXTRACT_FILE_LIMITS = {
  count: 16,
  totalBytes: 20 * 1024 * 1024,
} as const;

/** The models `models.extract` reads files with, as `provider/modelId`. */
export const MODELS_EXTRACT_MODELS = ["openai/gpt-6-luna", "openai/gpt-6.1-sol"] as const;
export type ModelsExtractModel = (typeof MODELS_EXTRACT_MODELS)[number];

/** Every extraction model offers each of these levels. */
export const MODELS_EXTRACT_THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ModelsExtractThinkingLevel = (typeof MODELS_EXTRACT_THINKING_LEVELS)[number];

const modelsExtractInputSchema = z.lazy(() =>
  z.strictObject({
    files: z
      .array(modelsFileSchema)
      .min(1)
      .max(MODELS_EXTRACT_FILE_LIMITS.count)
      .describe(
        "Ordered PDFs and PNG, JPEG, or WebP images to read, each a workspace file `{ path }` or " +
          "a blob `{ blob }` by key; requires upload.read for each. Blobs hold documents too " +
          `large for the workspace. Up to ${MODELS_EXTRACT_FILE_LIMITS.count} files and ` +
          `${MODELS_EXTRACT_FILE_LIMITS.totalBytes / 1024 ** 2} MiB together.`,
      ),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(32_000)
      .describe("What to read from the files and how to fill in the answer."),
    schema: z
      .record(z.string(), jsonValueSchema)
      .refine((schema) => schema["type"] === "object", {
        message: "The answer's schema is an object schema.",
      })
      .describe(
        "JSON Schema of the answer, in OpenAI's strict structured-output subset: the root is an " +
          "object, every object is closed and requires all its properties, which the call sets " +
          'itself, and a field that may be absent has a type such as `["string", "null"]`.',
      ),
    model: z
      .enum(MODELS_EXTRACT_MODELS)
      .default("openai/gpt-6-luna")
      .describe(
        "The model that reads the files. gpt-6.1-sol is the stronger model; it costs about 20 " +
          "times as much per token as gpt-6-luna and takes longer.",
      ),
    thinkingLevel: z
      .enum(MODELS_EXTRACT_THINKING_LEVELS)
      .default("low")
      .describe("How much the model reasons before it answers; more costs more and takes longer."),
  }),
);

const modelsExtractOutputSchema = z.lazy(() =>
  // A description would copy the shared JsonValue schema into a second, conflicting declaration.
  z.object({ output: jsonValueSchema }),
);

export const modelsOperations = {
  "models.classify": {
    description:
      "Answer typed questions about JSON state and images with a fast classifier model. A `choice` question " +
      "picks one option with probabilities, a `score` question rates against ordered levels, and " +
      "a `bool` question returns the probability that a condition holds. Use it for routing, " +
      "triage, and filtering; it does not generate text. Independent questions about the same " +
      "state and images belong in one call. Images require upload.read; text-only calls do not. " +
      "Each call is billed by input tokens, including image tokens.",
    permissions: [BACKOFFICE_PERMISSION.models.classify],
    input: modelsClassifyInputSchema,
    output: modelsClassifyOutputSchema,
  },
  "models.generateImage": {
    description:
      "Generate an image from a prompt and write it to the workspace. Generation can take up to " +
      "two minutes, longer than an immediate codemode run is allowed, so call it inside a " +
      "workflow step. Each call is billed by input and output tokens, which grow with size and " +
      "quality.",
    permissions: [BACKOFFICE_PERMISSION.models.generateImage, BACKOFFICE_PERMISSION.upload.modify],
    input: modelsGenerateImageInputSchema,
    output: modelsGenerateImageOutputSchema,
  },
  "models.extract": {
    description:
      "Read PDFs and images from the workspace or blobs with a model and answer in JSON that matches a " +
      "schema: invoice fields, a contract's parties, a statement's transactions, or a page as " +
      "Markdown. The files go to the model, not into the conversation, so only the answer costs " +
      "context. A long document can take longer than an immediate codemode run is allowed, so " +
      "call it inside a workflow step. Each call is billed by input and output tokens, " +
      "including every page and image.",
    permissions: [BACKOFFICE_PERMISSION.models.extract],
    input: modelsExtractInputSchema,
    output: modelsExtractOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
