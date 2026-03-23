import type { ReactNode } from "react";

import type { FilesNodeDetail } from "@/files";

type FilesContentRenderer = {
  id: string;
  label: string;
  render: (detail: FilesNodeDetail) => ReactNode;
};

const TextRenderer: FilesContentRenderer = {
  id: "text",
  label: "Text preview",
  render(detail) {
    return (
      <pre className="max-h-[32rem] overflow-auto text-sm leading-6 whitespace-pre-wrap text-[var(--bo-fg)]">
        {detail.textContent ?? ""}
      </pre>
    );
  },
};

const ImageRenderer: FilesContentRenderer = {
  id: "image",
  label: "Image preview",
  render(detail) {
    const src = getImageSource(detail);
    if (!src) {
      return (
        <p className="text-sm text-[var(--bo-muted)]">
          No image preview source is available yet for this file. Future contributors can provide a
          preview URL or data URL in node metadata.
        </p>
      );
    }

    return (
      <img
        src={src}
        alt={detail.node.title}
        className="max-h-[32rem] max-w-full rounded-sm border border-[color:var(--bo-border)] bg-[var(--bo-panel)] object-contain"
      />
    );
  },
};

export const FILES_CONTENT_RENDERERS_BY_CONTENT_TYPE = new Map<string, FilesContentRenderer>([
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

export const resolveFilesContentRenderer = (
  detail: FilesNodeDetail,
): FilesContentRenderer | null => {
  const normalizedContentType = detail.node.contentType?.toLowerCase() ?? null;

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

  if (detail.textContent !== null && detail.textContent !== undefined) {
    return TextRenderer;
  }

  return null;
};

const getImageSource = (detail: FilesNodeDetail): string | null => {
  const metadata = detail.metadata;
  const candidate =
    readString(metadata, "previewUrl") ??
    readString(metadata, "dataUrl") ??
    readString(metadata, "src") ??
    readString(metadata, "url");
  const ct = detail.node.contentType?.toLowerCase();

  if (candidate) {
    return candidate;
  }

  if (ct === "image/svg+xml" && detail.textContent) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(detail.textContent)}`;
  }

  return null;
};

const readString = (
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | null => {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
};
