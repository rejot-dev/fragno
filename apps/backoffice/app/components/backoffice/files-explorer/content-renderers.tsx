import type { ReactNode } from "react";
import { Streamdown } from "streamdown";

import { parseFrontmatter } from "@/lib/frontmatter";

export type FilesContentPreview = {
  title: string;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  textContent: string | null;
};

type FilesContentRenderer = {
  id: string;
  label: string;
  renderBefore?: (preview: FilesContentPreview) => ReactNode;
  render: (preview: FilesContentPreview) => ReactNode;
};

const TextRenderer: FilesContentRenderer = {
  id: "text",
  label: "Text preview",
  render(preview) {
    return (
      <pre className="backoffice-scroll h-full overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-[var(--bo-fg)]">
        {preview.textContent ?? ""}
      </pre>
    );
  },
};

const MarkdownRenderer: FilesContentRenderer = {
  id: "markdown",
  label: "Markdown preview",
  renderBefore(preview) {
    const { frontmatter } = readMarkdownDocument(preview);
    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      return null;
    }

    return (
      <section className="bg-[var(--bo-panel-2)] p-3 shadow-[inset_0_0_0_1px_var(--bo-border)] md:p-4">
        <p className="font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
          Frontmatter
        </p>
        <dl className="mt-3 divide-y divide-[var(--bo-border)] border-y border-[var(--bo-border)]">
          {Object.entries(frontmatter).map(([key, value]) => (
            <div key={key} className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
              <dt className="font-mono text-[10px] font-semibold text-[var(--bo-muted-2)]">
                {key}
              </dt>
              <dd className="min-w-0 text-sm leading-5 break-words text-[var(--bo-fg)]">
                {formatFrontmatterValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    );
  },
  render(preview) {
    const { body } = readMarkdownDocument(preview);

    return (
      <Streamdown
        mode="streaming"
        className="bo-file-markdown bo-session-markdown min-h-full text-sm leading-7 text-pretty"
        controls={{ code: true, table: true }}
        skipHtml
      >
        {body}
      </Streamdown>
    );
  },
};

function formatFrontmatterValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function readMarkdownDocument(preview: FilesContentPreview) {
  const content = preview.textContent ?? "";
  const parsed = parseFrontmatter<Record<string, unknown>>(content);

  return parsed.ok ? parsed.value : { frontmatter: null, body: content };
}

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
        className="h-full max-h-full max-w-full bg-[var(--bo-panel)] object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
    );
  },
};

const FILES_CONTENT_RENDERERS_BY_CONTENT_TYPE = new Map<string, FilesContentRenderer>([
  ["text/plain", TextRenderer],
  ["text/markdown", MarkdownRenderer],
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
  const normalizedContentType = normalizeMediaType(preview.contentType);

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
  if (normalizeMediaType(preview.contentType) === "image/svg+xml" && preview.textContent) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.textContent)}`;
  }
  return null;
}

function normalizeMediaType(contentType: string | null): string | null {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || null;
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
