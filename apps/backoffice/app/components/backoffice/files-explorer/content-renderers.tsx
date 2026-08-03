import type { ReactNode } from "react";

export type FilesContentPreview = {
  title: string;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  textContent: string | null;
};

type FilesContentRenderer = {
  id: string;
  label: string;
  render: (preview: FilesContentPreview) => ReactNode;
};

const TextRenderer: FilesContentRenderer = {
  id: "text",
  label: "Text preview",
  render(preview) {
    return (
      <pre className="backoffice-scroll max-h-[32rem] overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-[var(--bo-fg)]">
        {preview.textContent ?? ""}
      </pre>
    );
  },
};

const ImageRenderer: FilesContentRenderer = {
  id: "image",
  label: "Image preview",
  render(preview) {
    const src = getImageSource(preview);
    if (!src) {
      return (
        <p className="text-sm text-[var(--bo-muted)]">
          No image preview source is available yet for this file. File metadata may provide a
          preview URL or data URL.
        </p>
      );
    }

    return (
      <img
        src={src}
        alt={preview.title}
        className="max-h-[32rem] max-w-full bg-[var(--bo-panel)] object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
    );
  },
};

const FILES_CONTENT_RENDERERS_BY_CONTENT_TYPE = new Map<string, FilesContentRenderer>([
  ["text/plain", TextRenderer],
  ["text/markdown", TextRenderer],
  ["text/x-shellscript", TextRenderer],
  ["text/typescript", TextRenderer],
  ["application/json", TextRenderer],
  ["image/png", ImageRenderer],
  ["image/jpeg", ImageRenderer],
  ["image/gif", ImageRenderer],
  ["image/webp", ImageRenderer],
  ["image/svg+xml", ImageRenderer],
]);

export function resolveFilesContentRenderer(
  preview: FilesContentPreview,
): FilesContentRenderer | null {
  const normalizedContentType = preview.contentType?.toLowerCase() ?? null;

  if (normalizedContentType) {
    const exactRenderer = FILES_CONTENT_RENDERERS_BY_CONTENT_TYPE.get(normalizedContentType);
    if (exactRenderer) {
      return exactRenderer;
    }
    if (normalizedContentType.startsWith("text/")) {
      return TextRenderer;
    }
    if (normalizedContentType.startsWith("image/")) {
      return ImageRenderer;
    }
  }

  return preview.textContent !== null ? TextRenderer : null;
}

function getImageSource(preview: FilesContentPreview): string | null {
  const candidates = [
    readString(preview.metadata, "previewUrl"),
    readString(preview.metadata, "dataUrl"),
    readString(preview.metadata, "src"),
    readString(preview.metadata, "url"),
  ];

  for (const candidate of candidates) {
    if (candidate && isAllowedImageSource(candidate)) {
      return candidate;
    }
  }
  if (preview.contentType?.toLowerCase() === "image/svg+xml" && preview.textContent) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.textContent)}`;
  }
  return null;
}

function isAllowedImageSource(candidate: string): boolean {
  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    return true;
  }
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;[^,]*)?,/iu.test(candidate)) {
    return true;
  }
  if (typeof location === "undefined") {
    return false;
  }

  try {
    const url = new URL(candidate);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && url.origin === location.origin
    );
  } catch {
    return false;
  }
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
