import { z } from "zod";

/**
 * Clairic's contract, written here because Cloudflare's published schemas leave every value
 * untyped: a field's answer depends on its `type`, which only a union keyed on it can say. The
 * shapes follow Clairic's live answers, which also carry properties its schema omits, such as
 * `confidences`. Names are Clairic's wire names, since input passes through unchanged.
 */

const instructionsShape = {
  instructions: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("What the field holds and how to work it out."),
};

const nullThresholdShape = {
  null_threshold: z
    .number()
    .gt(0)
    .max(1)
    .optional()
    .describe(
      "Probability of absence above which `value` is null; 0.5 by default. 1 always answers the best guess.",
    ),
};

/** Estimates and forecasts answer on a grid between `min` and `max`. */
const gridShape = {
  min: z
    .union([z.number(), z.iso.date()])
    .describe("Lowest value considered: a number, or an ISO date for a date estimate."),
  max: z.union([z.number(), z.iso.date()]).describe("Highest value considered, like `min`."),
  step: z
    .union([z.number().positive(), z.enum(["month", "year"])])
    .optional()
    .describe("Grid spacing: a number, in days for dates, or `month` or `year`."),
  scale: z.enum(["linear", "log"]).optional().describe("`linear` by default."),
};

const clairicFieldSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("text").describe("A span of `state`, or text read from an image."),
      ...instructionsShape,
      ...nullThresholdShape,
    }),
    z.strictObject({
      type: z.literal("number"),
      ...instructionsShape,
      ...nullThresholdShape,
      unit: z.string().trim().min(1).optional().describe("Unit label, such as `USD`."),
      integer: z.boolean().optional(),
      decimals: z.number().int().min(0).max(6).optional(),
    }),
    z.strictObject({
      type: z
        .enum(["date", "time", "datetime"])
        .describe("Answers ISO `2026-10-02`, `14:35:00`, or `2026-11-03T14:35:00` without a zone."),
      ...instructionsShape,
      ...nullThresholdShape,
    }),
    z.strictObject({
      type: z.literal("duration"),
      ...instructionsShape,
      ...nullThresholdShape,
      unit: z
        .enum(["seconds", "minutes", "hours", "days", "weeks", "months", "years"])
        .optional()
        .describe("Unit of the answer; `seconds` by default."),
      integer: z.boolean().optional(),
      decimals: z.number().int().min(0).max(6).optional(),
    }),
    z.strictObject({
      type: z.literal("list"),
      ...instructionsShape,
      items: z.enum(["text", "number", "date"]).describe("What each item is."),
      decimals: z.number().int().min(0).max(6).optional().describe("Number lists only."),
    }),
    z.strictObject({
      type: z.literal("estimate").describe("A distribution over a value the input implies."),
      ...instructionsShape,
      ...gridShape,
    }),
    z.strictObject({
      type: z.literal("forecast").describe("One estimate per step of a series' continuation."),
      ...instructionsShape,
      ...gridShape,
      horizon: z.number().int().min(1).max(64).optional().describe("How many steps to forecast."),
      interval: z
        .enum(["step", "minute", "hour", "day", "week", "month", "quarter", "year"])
        .optional()
        .describe("How far apart the steps are."),
    }),
  ])
  .meta({ id: "ClairicField" });

const imageSchema = z.union([
  z
    .string()
    .regex(/^data:/iu)
    .describe("A `data:` URL of a PNG, JPEG, or WebP image."),
  z.strictObject({
    content_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().min(1).describe("The image's bytes, as from `bytes.toBase64()`."),
  }),
]);

export const clairicInputSchema = z
  .strictObject({
    model: z.literal("clairic"),
    state: z
      .string()
      .optional()
      .describe("The text to read; text answers are spans of it. Required without images."),
    fields: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u, {
          message:
            "Field names start with a letter or underscore and have at most 64 letters, digits, and `_.-`.",
        }),
        clairicFieldSchema,
      )
      .refine((fields) => Object.keys(fields).length > 0, {
        message: "Ask for at least one field.",
      })
      .describe("The values to answer, keyed by name; each answer has the same name."),
    images: z
      .array(imageSchema)
      .max(4)
      .optional()
      .describe("Up to 4 images, read before `state`: 4 MiB each and 8 MiB together."),
    reference_date: z.iso.date().optional().describe("Anchors dates written without a year."),
    options: z
      .strictObject({
        include_quantiles: z
          .boolean()
          .optional()
          .describe("Add the 1st to 99th percentiles to estimates and forecasts."),
        return_state_text: z
          .boolean()
          .optional()
          .describe("Return `state_text`, the text that spans index into."),
      })
      .optional(),
  })
  .refine((input) => (input.state ?? "").trim() !== "" || (input.images ?? []).length > 0, {
    message: "Give state, images, or both.",
    path: ["state"],
  });

const spanSchema = z
  .array(z.number().int())
  .length(2)
  .describe("Start and end character offsets in the state text.");

/** A valued answer is null when the input does not determine it, unlike its `guess`. */
function valuedAnswerShape<TType extends z.ZodType, TValue extends z.ZodType>(
  type: TType,
  value: TValue,
) {
  return {
    type,
    value: value.nullable().describe("Null when `p_null` exceeds the field's `null_threshold`."),
    guess: value.nullable().describe("The best answer, even when `value` is null."),
    confidence: z.number().describe("Probability that `guess` is right."),
    p_null: z.number().describe("Probability that the input does not determine the field."),
  };
}

const distributionShape = {
  mean: z.union([z.number(), z.string()]),
  median: z.union([z.number(), z.string()]),
  p10: z.union([z.number(), z.string()]),
  p90: z.union([z.number(), z.string()]),
  quantiles: z
    .array(z.union([z.number(), z.string()]))
    .optional()
    .describe("The 1st to 99th percentiles, with `options.include_quantiles`."),
  p_below: z.number().optional().describe("Probability of a value below `min`; absent for dates."),
  p_above: z.number().optional().describe("Probability of a value above `max`; absent for dates."),
};

const estimateShape = {
  value: z
    .union([z.number(), z.string()])
    .describe("The most likely value: a number, or an ISO date."),
  ...distributionShape,
};

const clairicAnswerSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...valuedAnswerShape(z.literal("text"), z.string()),
      span: spanSchema.optional().describe("Where `guess` stands in the state text."),
    }),
    z.object(valuedAnswerShape(z.literal("number"), z.number())),
    z.object(valuedAnswerShape(z.enum(["date", "time", "datetime"]), z.string())),
    z.object({
      ...valuedAnswerShape(z.literal("duration"), z.number()),
      unit: z.string().describe("Unit of `value` and `guess`."),
    }),
    z.object({
      type: z.literal("list"),
      value: z
        .union([z.array(z.string()), z.array(z.number())])
        .describe("The items, texts and ISO dates as strings; empty when there are none."),
      confidence: z.number().describe("Probability that the whole list is right."),
      confidences: z.array(z.number()).optional().describe("Per item, for number and date lists."),
      spans: z.array(spanSchema).optional().describe("Per item, for text lists."),
    }),
    z.object({ type: z.literal("estimate"), ...estimateShape }),
    z.object({
      type: z.literal("forecast"),
      value: z.array(z.number()).describe("The most likely value of each step."),
      median: z.array(z.number()),
      p10: z.array(z.number()),
      p90: z.array(z.number()),
      steps: z.array(z.object(estimateShape)).describe("One estimate per step."),
    }),
  ])
  .meta({ id: "ClairicAnswer" });

export const clairicOutputSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), clairicAnswerSchema).describe("One answer per requested field."),
  truncated: z.boolean().describe("Whether the state text was cut to fit the model's context."),
  state_text: z.string().optional().describe("With `options.return_state_text`."),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    state_tokens: z.number().int().optional(),
    image_tokens: z.number().int().optional(),
    schema_tokens: z.number().int().optional(),
    passes: z.number().int().optional(),
  }),
});

/**
 * Where Cloudflare's published input schema has moved past this contract: field types or field
 * options Clairic now accepts that callers cannot send through Backoffice.
 */
export function clairicContractDrift(cloudflareInput: Record<string, unknown>): string[] {
  const spec = readPath(cloudflareInput, ["properties", "fields", "additionalProperties"]);
  const types = readPath(spec, ["properties", "type", "enum"]);
  const options = readPath(spec, ["properties"]);
  if (!Array.isArray(types) || typeof options !== "object" || options === null) {
    return ["Cloudflare no longer publishes Clairic's field types where Backoffice expects them."];
  }
  const knownTypes = new Set<string>(
    clairicFieldSchema.options.flatMap(({ shape: { type } }) =>
      type instanceof z.ZodLiteral ? [...type.values] : type.options,
    ),
  );
  const knownOptions = new Set(
    clairicFieldSchema.options.flatMap((variant) => Object.keys(variant.shape)),
  );
  const newTypes = types.filter((type) => !knownTypes.has(String(type)));
  const newOptions = Object.keys(options).filter((option) => !knownOptions.has(option));
  return [
    ...(newTypes.length > 0
      ? [`Clairic accepts field types Backoffice lacks: ${newTypes.join(", ")}.`]
      : []),
    ...(newOptions.length > 0
      ? [`Clairic accepts field options Backoffice lacks: ${newOptions.join(", ")}.`]
      : []),
  ];
}

function readPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );
}
