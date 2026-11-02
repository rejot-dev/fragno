import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { isoDateTimeOutputSchema } from "./shared/datetime";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { backofficeRoutableScopeSchema } from "./shared/scope";

/** Where a scope reads what other scopes share with it, as files or as blob keys. */
export const SHARED_MOUNT_POINT = "/shared";

const sharedContentsSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("folder"),
      path: z
        .string()
        .trim()
        .min(1)
        .describe("A /workspace folder, such as /workspace/reports/2026/."),
    }),
    z.strictObject({
      kind: z.literal("blobs"),
      prefix: z
        .string()
        .trim()
        .min(1)
        .describe("The blobs whose keys start with this folder-like prefix, such as calls/2026/."),
    }),
  ]),
);

export type SharedContents = z.output<typeof sharedContentsSchema>;

const shareSchema = z.lazy(() =>
  z.strictObject({
    shareId: z.string(),
    of: sharedContentsSchema.describe(
      "What the share opens: a folder ending in /, or the blobs under a prefix ending in /.",
    ),
    with: backofficeRoutableScopeSchema.describe("The scope that may accept and read it."),
    sharedAt: isoDateTimeOutputSchema,
  }),
);

/** The longest name a scope reads a share under. */
export const SHARE_NAME_MAX_LENGTH = 64;

/** A segment of /shared, like a project slug: lowercase letters and digits joined by dashes. */
const shareNameSchema = z.lazy(() =>
  z
    .string()
    .max(SHARE_NAME_MAX_LENGTH)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
      "Share names are lowercase letters and digits joined by dashes, such as client1-invoices.",
    ),
);

const acceptedShareSchema = z.lazy(() =>
  z.strictObject({
    shareId: z.string(),
    name: z.string().describe("The name this scope reads the share under."),
    from: backofficeRoutableScopeSchema.describe("The scope that shared it."),
    of: sharedContentsSchema.describe("What the sharing scope shares, in its own terms."),
    path: z
      .string()
      .describe(
        `Where this scope reads the share, read-only: ${SHARED_MOUNT_POINT}/<name>/. A folder's files are at this path, and search and glob enter it only when the pattern starts with it. Blobs are under it as keys, for blobs.get, blobs.list, blobs.read, and blobs.createDownloadUrl.`,
      ),
    acceptedAt: isoDateTimeOutputSchema,
  }),
);

export type Share = z.output<typeof shareSchema>;
export type AcceptedShare = z.output<typeof acceptedShareSchema>;

export const sharesOperations = {
  "shares.create": {
    description: `Share a /workspace folder, or the blobs under a key prefix, with another scope, read-only and without copying. The other scope reads it at ${SHARED_MOUNT_POINT}/<name>/ once it accepts the share with shares.accept, until either scope revokes it. A download URL created from a shared blob still works until it expires.`,
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() =>
      z.strictObject({
        of: sharedContentsSchema.describe("What to share."),
        with: backofficeRoutableScopeSchema.describe("The scope to share it with."),
      }),
    ),
    output: shareSchema,
  },
  "shares.accept": {
    description: `Accept a folder or blobs another scope shared with this one, so this scope reads them at ${SHARED_MOUNT_POINT}/<name>/. Accepting a share again returns it under the name it has.`,
    permissions: [BACKOFFICE_PERMISSION.upload.modify],
    input: z.lazy(() =>
      z.strictObject({
        from: backofficeRoutableScopeSchema.describe("The scope that shared it."),
        shareId: z.string().trim().min(1),
        name: shareNameSchema
          .optional()
          .describe(
            "The name to read the share under, unique in this scope. Defaults to the share's ID.",
          ),
      }),
    ),
    output: acceptedShareSchema,
  },
  "shares.list": {
    description: "List what this scope shared with other scopes and the shares it accepted.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() => z.strictObject({})),
    output: z.lazy(() =>
      z.strictObject({
        shared: z.array(shareSchema),
        accepted: z.array(acceptedShareSchema),
      }),
    ),
  },
  "shares.revoke": {
    description: `End a share: revoking one this scope shared stops the other scope reading it, and revoking one this scope accepted removes it from ${SHARED_MOUNT_POINT}.`,
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: z.lazy(() => z.strictObject({ shareId: z.string().trim().min(1) })),
    output: z.void(),
  },
} satisfies Record<string, BackofficeApiOperation>;
