import { jsonValueSchema } from "@fragno-dev/backoffice-api/v0/shared/json";
import { z } from "zod";

/** Built-in task hooks whose asynchronous callbacks can execute in a fresh codemode activation. */
export const PI_WORKSPACE_EXTENSION_HOOKS = {
  "pi.generation": ["beforeRequest", "afterResponse", "onYield", "afterTools"],
  "pi.tool": ["beforeTool", "afterTool"],
  "pi.compaction": ["beforeCompact"],
} as const;

/** Registration data only; executable extension members never leave the isolated Worker. */
export const piWorkspaceExtensionMetadataSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/),
    sections: z
      .array(z.strictObject({ key: z.string().min(1).max(128), tag: z.boolean() }))
      .max(16),
    tools: z
      .array(
        z.strictObject({
          name: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
          description: z.string().min(1).max(16_384),
          parameters: z.record(z.string(), jsonValueSchema),
          replay: z.enum(["safe", "unsafe"]),
          executionMode: z.enum(["parallel", "sequential"]).nullable(),
          outputLimits: z
            .strictObject({
              maxBytes: z.number().int().positive().max(65_536).nullable(),
              maxLines: z.number().int().positive().max(10_000).nullable(),
              retain: z.enum(["head", "tail"]).nullable(),
            })
            .nullable(),
        }),
      )
      .max(16),
    hooks: z
      .array(
        z.discriminatedUnion("task", [
          z.strictObject({
            task: z.literal("pi.generation"),
            handlers: z.array(z.enum(PI_WORKSPACE_EXTENSION_HOOKS["pi.generation"])).min(1).max(4),
          }),
          z.strictObject({
            task: z.literal("pi.tool"),
            handlers: z.array(z.enum(PI_WORKSPACE_EXTENSION_HOOKS["pi.tool"])).min(1).max(2),
          }),
          z.strictObject({
            task: z.literal("pi.compaction"),
            handlers: z.array(z.enum(PI_WORKSPACE_EXTENSION_HOOKS["pi.compaction"])).min(1).max(1),
          }),
        ]),
      )
      .max(16),
  })
  .refine(
    (extension) => extension.sections.length + extension.tools.length + extension.hooks.length > 0,
    {
      message: "PI_EXTENSION_EMPTY: provide a section, tool, or built-in hook.",
    },
  );
