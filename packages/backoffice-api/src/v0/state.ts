import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { base64BytesSchema } from "./shared/bytes";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { jsonValueSchema } from "./shared/json";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const fileSearchOptionsSchema = z.lazy(() =>
  z.strictObject({
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    contextBefore: z.number().optional(),
    contextAfter: z.number().optional(),
    maxMatches: z.number().optional(),
  }),
);

export const mountFileSearchOptionsSchema = z.lazy(() =>
  fileSearchOptionsSchema._zod.innerType.extend({
    cursor: z.string().optional(),
  }),
);

export const fileEditSearchOptionsSchema = z.lazy(() =>
  z.strictObject({
    caseSensitive: z.boolean().optional(),
    regex: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    maxMatches: z.number().optional(),
  }),
);

export const textSearchOptionsSchema = z.lazy(() =>
  fileSearchOptionsSchema._zod.innerType.extend({
    regex: z.boolean().optional(),
  }),
);

export const textMatchSchema = z.lazy(() =>
  z.strictObject({
    line: z.number(),
    column: z.number(),
    match: z.string(),
    lineText: z.string(),
    beforeLines: z.array(z.string()).optional(),
    afterLines: z.array(z.string()).optional(),
  }),
);

export const statOutputSchema = z.lazy(() =>
  z
    .strictObject({
      type: z.enum(["file", "directory"]),
      size: z.number(),
      mtime: isoDateTimeOutputSchema,
    })
    .nullable(),
);

export const pathInputSchema = z.lazy(() =>
  z.strictObject({
    path: z.string(),
  }),
);

export const fileSearchPageSchema = z.lazy(() =>
  z.strictObject({
    results: z.array(
      z.strictObject({
        path: z.string(),
        matches: z.array(textMatchSchema),
      }),
    ),
    cursor: z.string().optional(),
    hasMore: z.boolean(),
  }),
);

export const fileSearchOptionsByMountSchema = z.lazy(() =>
  z.strictObject({
    upload: mountFileSearchOptionsSchema.optional(),
    static: mountFileSearchOptionsSchema.optional(),
  }),
);

export const fileEditSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
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
  ]),
);

export const appliedFileEditSchema = z.lazy(() =>
  z.strictObject({
    path: z.string(),
    changed: z.boolean(),
    content: z.string(),
    diff: z.string(),
  }),
);

const fileLinkInputSchema = z.lazy(() =>
  z.object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe(
        "A path in this scope's Backoffice workspace, the files state.readFile reads, not a path inside a sandbox: a /workspace file, a folder ending in /, or a glob with * or ?, for example /workspace/data/*.csv.",
      ),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(3_600)
      .optional()
      .describe("How long the link works. Defaults to 900 seconds."),
  }),
);

const fileLinkSchema = z.lazy(() =>
  z.discriminatedUnion("format", [
    z.object({
      format: z.literal("file").describe("The URL's body is the file itself."),
      url: z.string().describe("The public URL, for people and services outside Backoffice."),
      sandboxUrl: z
        .string()
        .describe(
          "The URL for sandbox commands; use it unchanged, since its host may resolve only inside sandboxes.",
        ),
      path: z.string().describe("The linked file's path in the Backoffice workspace."),
      expiresAt: z.iso.datetime(),
    }),
    z.object({
      format: z.literal("tar").describe("The URL's body is a tar archive of the matching files."),
      url: z.string().describe("The public URL, for people and services outside Backoffice."),
      sandboxUrl: z
        .string()
        .describe(
          "The URL for sandbox commands; use it unchanged, since its host may resolve only inside sandboxes.",
        ),
      glob: z.string().describe("The Backoffice workspace paths the link matches."),
      root: z
        .string()
        .describe("The Backoffice workspace folder that archive entry names are relative to."),
      expiresAt: z.iso.datetime(),
    }),
  ]),
);

export type FileLinkInput = z.output<typeof fileLinkInputSchema>;
export type FileLink = z.output<typeof fileLinkSchema>;

export const stateOperations = {
  "state.readFileBytes": {
    description: "Read a file from the scope's state as base64-encoded bytes.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: base64BytesSchema,
  },
  "state.writeFileBytes": {
    description: "Write base64-encoded bytes to a file in the scope's state.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() => z.strictObject({ path: z.string(), content: base64BytesSchema })),
    output: z.void(),
  },
  "state.appendFile": {
    description: "Append UTF-8 text, or base64-encoded bytes, to a file in the scope's state.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      }),
    ),
    output: z.void(),
  },
  "state.readFile": {
    description: "Read a UTF-8 text file from codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: z.lazy(() => z.string()),
  },
  "state.writeFile": {
    description: "Write a UTF-8 text file to mutable codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string(),
        content: z.string(),
      }),
    ),
    output: z.void(),
  },
  "state.exists": {
    description: "Check whether a codemode state path exists.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: z.lazy(() => z.boolean()),
  },
  "state.stat": {
    description: "Read metadata for a codemode state path.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: statOutputSchema,
  },
  "state.lstat": {
    description: "Read metadata for a codemode state path without following links.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: statOutputSchema,
  },
  "state.mkdir": {
    description: "Create a directory in mutable codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: pathInputSchema,
    output: z.void(),
  },
  "state.readdir": {
    description: "List the names directly below a codemode state directory.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: z.lazy(() => z.array(z.string())),
  },
  "state.readdirWithFileTypes": {
    description: "List names and entry types directly below a codemode state directory.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: z.lazy(() =>
      z.array(
        z.strictObject({
          name: z.string(),
          type: z.enum(["file", "directory"]),
        }),
      ),
    ),
  },
  "state.rm": {
    description: "Remove a file or empty directory from mutable codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string(),
        options: z
          .strictObject({
            force: z.boolean().optional(),
          })
          .optional(),
      }),
    ),
    output: z.void(),
  },
  "state.cp": {
    description: "Copy one file within mutable codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.read, BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        src: z.string(),
        dest: z.string(),
      }),
    ),
    output: z.void(),
  },
  "state.mv": {
    description: "Move one file within mutable codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.read, BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        src: z.string(),
        dest: z.string(),
      }),
    ),
    output: z.void(),
  },
  "state.realpath": {
    description: "Resolve and validate a codemode state path.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: z.lazy(() => z.string()),
  },
  "state.resolvePath": {
    description: "Resolve a path against a base path without accessing storage.",
    permissions: [],
    input: z.lazy(() =>
      z.strictObject({
        base: z.string(),
        path: z.string(),
      }),
    ),
    output: z.lazy(() => z.string()),
  },
  "state.glob": {
    description: "Find codemode state paths matching a glob pattern.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() =>
      z.strictObject({
        pattern: z.string(),
      }),
    ),
    output: z.lazy(() => z.array(z.string())),
  },
  "state.readJson": {
    description: "Read and parse a JSON file from codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: pathInputSchema,
    output: jsonValueSchema,
  },
  "state.writeJson": {
    description: "Serialize and write a JSON value to mutable codemode state.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string(),
        value: jsonValueSchema,
        options: z
          .strictObject({
            spaces: z.number().optional(),
          })
          .optional(),
      }),
    ),
    output: z.void(),
  },
  "state.applyEdits": {
    description: "Atomically apply text and JSON edits to mutable codemode state files.",
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        edits: z.array(fileEditSchema),
      }),
    ),
    output: z.lazy(() =>
      z.strictObject({
        edits: z.array(appliedFileEditSchema),
        totalChanged: z.number(),
      }),
    ),
  },
  "state.searchText": {
    description: "Search for text within one codemode state file.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string(),
        query: z.string(),
        options: textSearchOptionsSchema.optional(),
      }),
    ),
    output: z.lazy(() => z.array(textMatchSchema)),
  },
  "state.searchFiles": {
    description:
      "Search codemode state files matching a glob pattern for lines containing any of the keywords.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() =>
      z.strictObject({
        pattern: z.string(),
        // The upload index runs one pass per keyword, so it bounds how many a search may ask for.
        keywords: z.array(z.string().min(1).max(512)).min(1).max(8),
        options: fileSearchOptionsByMountSchema.optional(),
      }),
    ),
    output: z.lazy(() =>
      z.strictObject({
        upload: fileSearchPageSchema,
        static: fileSearchPageSchema,
      }),
    ),
  },
  "state.hashFile": {
    description: "Hash the bytes of one codemode state file.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() =>
      z.strictObject({
        path: z.string(),
        algorithm: z.enum(["md5", "sha1", "sha256"]).default("sha256"),
      }),
    ),
    output: z.lazy(() => z.string()),
  },
  "state.createDownloadLink": {
    description:
      'Create a temporary URL that reads workspace files without credentials. Give `url` to people and services outside Backoffice; browsers download the file. Sandbox commands use `sandboxUrl`. A file path links the file: `curl -sS --fail-with-body "$sandboxUrl" -o file`. A folder or glob links an uncompressed tar archive of up to 500 matching files named relative to `root`: `curl -sS --fail-with-body "$sandboxUrl" | tar -x -C dir`. When the archive response has an X-Next-Cursor header, request the URL again with ?cursor=<value> for the next files. Anyone holding the URL can read these files until it expires.',
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: fileLinkInputSchema,
    output: fileLinkSchema,
  },
  "state.createUploadLink": {
    description:
      'Create a temporary URL that writes workspace files without credentials. Give `url` to services outside Backoffice; sandbox commands use `sandboxUrl`. Writes replace existing files. Each file may be at most 1.9 MB. A file path accepts the file: `curl -sS --fail-with-body -H "Expect:" -T file "$sandboxUrl"`. A folder or glob accepts an uncompressed tar archive of at most 200 regular files and 25 MB, without symlinks, whose entry names are relative to `root` and must match: `tar -ch -C dir . | curl -sS --fail-with-body -H "Expect:" -T - "$sandboxUrl"`. Push only the files the task produced, never a whole project; an archive is written all-or-nothing. A successful write returns `{"fileCount","sizeBytes"}`. Anyone holding the URL can write these files until it expires.',
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: fileLinkInputSchema,
    output: fileLinkSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
