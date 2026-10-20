import { z } from "zod";

import { absoluteFilePathSchema } from "@/file-collection/absolute-file-path";

export const imageDefinition = {
  props: z.strictObject({
    path: absoluteFilePathSchema.max(2048),
    alt: z.string().min(1).max(500),
  }),
  slots: [],
  description:
    "Displays a PNG, JPEG, GIF, WebP, or SVG file from the current Backoffice scope. Use an absolute virtual file path (for example /workspace/screenshots/dashboard.png), not a URL or base64. Files remain private and are fetched with the viewer's authorization.",
  example: { path: "/workspace/screenshots/dashboard.png", alt: "Dashboard preview" },
};
