import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { pathInputSchema } from "@fragno-dev/backoffice-api/v0/state";
import { z } from "zod";

import type { ImageContent } from "@earendil-works/pi-ai";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  StateFileReadLimitError,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { bytesToBase64 } from "@/lib/base64";
import { rasterImageContentType } from "@/lib/raster-image-content-type";
import { inspectRasterImage } from "@/lib/raster-image-structure";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

/** Takes the images an agent's program views, for the model to see with the program's output. */
export type ImageViewer = {
  /**
   * Views the image `read` returns. Its place is taken before `read` starts, with the file bytes
   * left in the program's budget, so calls beyond the limits fail before they read anything.
   */
  view<T extends { image: ImageContent }>(read: (maxFileBytes: number) => Promise<T>): Promise<T>;
};

type ImageViewerToolContext = BackofficeToolContext<{
  state?: BackofficeStateBackend;
  imageViewer?: ImageViewer;
}>;

// A tool result is stored as one Durable Object SQLite row, which Cloudflare caps at 2 MB (local
// workerd does not enforce it). Its images share what the result's text and details leave.
const VIEWED_IMAGES_BASE64_BYTES = 1_500_000;
// A viewed image stays in the conversation, so every later request pays its tokens again.
const MAX_VIEWED_IMAGES = 8;
// The base64 the model receives is a third larger than the file.
const MAX_IMAGE_FILE_BYTES = Math.floor((VIEWED_IMAGES_BASE64_BYTES * 3) / 4);

function sharedBytesLimitError() {
  return new BackofficeOperationError(
    "invalid_request",
    `STATE_VIEW_IMAGE_LIMIT: The images one program views share ${MAX_IMAGE_FILE_BYTES} bytes; view the rest in another program.`,
  );
}

/** The images one program views, within what a single tool result can carry. */
export function createViewedImages(): { viewer: ImageViewer; images: ImageContent[] } {
  const images: ImageContent[] = [];
  let base64Bytes = 0;
  // Reads in flight hold places too, so a program viewing in parallel reads at most the limit.
  let reading = 0;
  return {
    images,
    viewer: {
      view: async (read) => {
        if (images.length + reading === MAX_VIEWED_IMAGES) {
          throw new BackofficeOperationError(
            "invalid_request",
            `STATE_VIEW_IMAGE_LIMIT: A program can view at most ${MAX_VIEWED_IMAGES} images; view the rest in another program.`,
          );
        }
        // Every 3 file bytes become 4 of base64.
        const maxFileBytes = Math.floor((VIEWED_IMAGES_BASE64_BYTES - base64Bytes) / 4) * 3;
        if (maxFileBytes === 0) {
          throw sharedBytesLimitError();
        }
        reading += 1;
        try {
          const viewed = await read(maxFileBytes);
          // Parallel reads each had the whole remaining budget; the first to finish takes it.
          if (base64Bytes + viewed.image.data.length > VIEWED_IMAGES_BASE64_BYTES) {
            throw sharedBytesLimitError();
          }
          base64Bytes += viewed.image.data.length;
          images.push(viewed.image);
          return viewed;
        } finally {
          reading -= 1;
        }
      },
    },
  };
}

async function readImageFile(
  state: BackofficeStateBackend,
  path: string,
  maxFileBytes: number,
): Promise<Uint8Array> {
  try {
    return await state.readFileBytes(path, maxFileBytes);
  } catch (error) {
    if (!(error instanceof StateFileReadLimitError)) {
      throw error;
    }
    if (maxFileBytes < MAX_IMAGE_FILE_BYTES) {
      throw sharedBytesLimitError();
    }
    throw new BackofficeOperationError(
      "invalid_request",
      `STATE_VIEW_IMAGE_TOO_LARGE: ${path} exceeds ${MAX_IMAGE_FILE_BYTES} bytes, the most a program can view. Capture a smaller viewport or clip, or save it as JPEG.`,
    );
  }
}

const viewImageTool = defineBackofficeRuntimeTool({
  id: "state.viewImage",
  namespace: "state",
  name: "viewImage",
  description: `Look at a PNG, JPEG, or WebP image in state yourself: it follows the program's output in your tool result. Only agents can view images, each at most ${DEFAULT_IMAGE_LIMITS.maxWidth}×${DEFAULT_IMAGE_LIMITS.maxHeight} pixels; one program views at most ${MAX_VIEWED_IMAGES} images of ${MAX_IMAGE_FILE_BYTES} bytes together.`,
  requiredPermissions: [BACKOFFICE_PERMISSION.upload.read],
  inputSchema: pathInputSchema,
  outputSchema: z.object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int(),
    height: z.number().int(),
  }),
  execute: async ({ path }, context: ImageViewerToolContext) => {
    const { state, imageViewer } = context.runtimes;
    if (!state || !imageViewer) {
      throw new Error("Viewing images is only available to agents.");
    }
    const { mimeType, width, height } = await imageViewer.view(async (maxFileBytes) => {
      const bytes = await readImageFile(state, path, maxFileBytes);
      const mimeType = rasterImageContentType(bytes);
      if (mimeType === null || mimeType === "image/gif") {
        throw new BackofficeOperationError(
          "invalid_request",
          `STATE_VIEW_IMAGE_INVALID: ${path} must contain a PNG, JPEG, or WebP image.`,
        );
      }
      // A broken image would stay in the conversation, and providers reject every request with it.
      const dimensions = inspectRasterImage(bytes, mimeType);
      if (dimensions === null) {
        throw new BackofficeOperationError(
          "invalid_request",
          `STATE_VIEW_IMAGE_INVALID: ${path} is not a complete ${mimeType} image; it is cut short or damaged.`,
        );
      }
      // Providers also reject images beyond their limits, so an oversized one is refused rather
      // than viewed.
      if (
        dimensions.width > DEFAULT_IMAGE_LIMITS.maxWidth ||
        dimensions.height > DEFAULT_IMAGE_LIMITS.maxHeight
      ) {
        throw new BackofficeOperationError(
          "invalid_request",
          `STATE_VIEW_IMAGE_TOO_LARGE: ${path} is ${dimensions.width}×${dimensions.height} pixels; the most you can view is ${DEFAULT_IMAGE_LIMITS.maxWidth}×${DEFAULT_IMAGE_LIMITS.maxHeight}. Capture a smaller viewport or clip.`,
        );
      }
      return {
        image: { type: "image", data: bytesToBase64(bytes), mimeType },
        mimeType,
        ...dimensions,
      };
    });
    return { mimeType, width, height };
  },
});

export const imageViewerToolFamily = defineBackofficeRuntimeToolFamily<ImageViewerToolContext>({
  namespace: "state",
  tools: [viewImageTool],
  isAvailable: (context) => Boolean(context.runtimes.state && context.runtimes.imageViewer),
});
