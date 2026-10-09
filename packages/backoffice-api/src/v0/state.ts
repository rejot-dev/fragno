import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { base64BytesSchema } from "./shared/bytes";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { jsonValueSchema } from "./shared/json";

export const fileSearchOptionsSchema = z.strictObject({
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  contextBefore: z.number().optional(),
  contextAfter: z.number().optional(),
  maxMatches: z.number().optional(),
});

export const mountFileSearchOptionsSchema = fileSearchOptionsSchema.extend({
  cursor: z.string().optional(),
});

export const fileEditSearchOptionsSchema = z.strictObject({
  caseSensitive: z.boolean().optional(),
  regex: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  maxMatches: z.number().optional(),
});

export const textSearchOptionsSchema = fileSearchOptionsSchema.extend({
  regex: z.boolean().optional(),
});

export const textMatchSchema = z.strictObject({
  line: z.number(),
  column: z.number(),
  match: z.string(),
  lineText: z.string(),
  beforeLines: z.array(z.string()).optional(),
  afterLines: z.array(z.string()).optional(),
});

export const statOutputSchema = z
  .strictObject({
    type: z.enum(["file", "directory"]),
    size: z.number(),
    mtime: isoDateTimeOutputSchema,
  })
  .nullable();

export const pathInputSchema = z.strictObject({
  path: z.string(),
});

export const fileSearchPageSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      path: z.string(),
      matches: z.array(textMatchSchema),
    }),
  ),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
});

export const fileSearchOptionsByMountSchema = z.strictObject({
  upload: mountFileSearchOptionsSchema.optional(),
  static: mountFileSearchOptionsSchema.optional(),
});

export const fileEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("write"),
    path: z.string(),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal("replace"),
    path: z.string(),
    search: z.string(),
    replacement: z.string(),
    options: fileEditSearchOptionsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("writeJson"),
    path: z.string(),
    value: jsonValueSchema,
    options: z.strictObject({ spaces: z.number().optional() }).optional(),
  }),
]);

export const appliedFileEditSchema = z.strictObject({
  path: z.string(),
  changed: z.boolean(),
  content: z.string(),
  diff: z.string(),
});

export const stateOperations = {
  "state.readFileBytes": {
    description: "Read a file from the scope's state as base64-encoded bytes.",
    input: pathInputSchema,
    output: base64BytesSchema,
  },
  "state.writeFileBytes": {
    description: "Write base64-encoded bytes to a file in the scope's state.",
    input: z.strictObject({ path: z.string(), content: base64BytesSchema }),
    output: z.void(),
  },
  "state.appendFile": {
    description: "Append UTF-8 text, or base64-encoded bytes, to a file in the scope's state.",
    input: z.strictObject({
      path: z.string(),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }),
    output: z.void(),
  },
  "state.readFile": {
    description: "Read a UTF-8 text file from codemode state.",
    input: pathInputSchema,
    output: z.string(),
  },
  "state.writeFile": {
    description: "Write a UTF-8 text file to mutable codemode state.",
    input: z.strictObject({
      path: z.string(),
      content: z.string(),
    }),
    output: z.void(),
  },
  "state.exists": {
    description: "Check whether a codemode state path exists.",
    input: pathInputSchema,
    output: z.boolean(),
  },
  "state.stat": {
    description: "Read metadata for a codemode state path.",
    input: pathInputSchema,
    output: statOutputSchema,
  },
  "state.lstat": {
    description: "Read metadata for a codemode state path without following links.",
    input: pathInputSchema,
    output: statOutputSchema,
  },
  "state.mkdir": {
    description: "Create a directory in mutable codemode state.",
    input: pathInputSchema,
    output: z.void(),
  },
  "state.readdir": {
    description: "List the names directly below a codemode state directory.",
    input: pathInputSchema,
    output: z.array(z.string()),
  },
  "state.readdirWithFileTypes": {
    description: "List names and entry types directly below a codemode state directory.",
    input: pathInputSchema,
    output: z.array(
      z.strictObject({
        name: z.string(),
        type: z.enum(["file", "directory"]),
      }),
    ),
  },
  "state.rm": {
    description: "Remove a file or empty directory from mutable codemode state.",
    input: z.strictObject({
      path: z.string(),
      options: z
        .strictObject({
          force: z.boolean().optional(),
        })
        .optional(),
    }),
    output: z.void(),
  },
  "state.cp": {
    description: "Copy one file within mutable codemode state.",
    input: z.strictObject({
      src: z.string(),
      dest: z.string(),
    }),
    output: z.void(),
  },
  "state.mv": {
    description: "Move one file within mutable codemode state.",
    input: z.strictObject({
      src: z.string(),
      dest: z.string(),
    }),
    output: z.void(),
  },
  "state.realpath": {
    description: "Resolve and validate a codemode state path.",
    input: pathInputSchema,
    output: z.string(),
  },
  "state.resolvePath": {
    description: "Resolve a path against a base path without accessing storage.",
    input: z.strictObject({
      base: z.string(),
      path: z.string(),
    }),
    output: z.string(),
  },
  "state.glob": {
    description: "Find codemode state paths matching a glob pattern.",
    input: z.strictObject({
      pattern: z.string(),
    }),
    output: z.array(z.string()),
  },
  "state.readJson": {
    description: "Read and parse a JSON file from codemode state.",
    input: pathInputSchema,
    output: jsonValueSchema,
  },
  "state.writeJson": {
    description: "Serialize and write a JSON value to mutable codemode state.",
    input: z.strictObject({
      path: z.string(),
      value: jsonValueSchema,
      options: z
        .strictObject({
          spaces: z.number().optional(),
        })
        .optional(),
    }),
    output: z.void(),
  },
  "state.applyEdits": {
    description: "Atomically apply text and JSON edits to mutable codemode state files.",
    input: z.strictObject({
      edits: z.array(fileEditSchema),
    }),
    output: z.strictObject({
      edits: z.array(appliedFileEditSchema),
      totalChanged: z.number(),
    }),
  },
  "state.searchText": {
    description: "Search for text within one codemode state file.",
    input: z.strictObject({
      path: z.string(),
      query: z.string(),
      options: textSearchOptionsSchema.optional(),
    }),
    output: z.array(textMatchSchema),
  },
  "state.searchFiles": {
    description: "Search for text across codemode state files matching a glob pattern.",
    input: z.strictObject({
      pattern: z.string(),
      query: z.string(),
      options: fileSearchOptionsByMountSchema.optional(),
    }),
    output: z.strictObject({
      upload: fileSearchPageSchema,
      static: fileSearchPageSchema,
    }),
  },
  "state.hashFile": {
    description: "Hash the bytes of one codemode state file.",
    input: z.strictObject({
      path: z.string(),
      algorithm: z.enum(["md5", "sha1", "sha256"]).default("sha256"),
    }),
    output: z.string(),
  },
} satisfies Record<string, BackofficeApiOperation>;
