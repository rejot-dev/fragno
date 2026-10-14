import type { ReactNode } from "react";

import { Icon } from "./icon";
import { ImagePreview } from "./image-preview";

export function ImagePreviewCard({
  src,
  alt,
  filename,
  action,
}: {
  src: string;
  alt: string;
  filename: string;
  action: ReactNode;
}) {
  // Phrasing elements keep image cards valid inside Markdown paragraphs.
  return (
    <span className="my-1 inline-flex w-fit max-w-full flex-col overflow-hidden rounded-[4px] bg-[var(--bo-panel)] align-top shadow-[var(--bo-panel-shadow)]">
      <span className="flex min-h-24 min-w-0 items-center justify-center bg-[var(--bo-panel-2)] p-2">
        <ImagePreview src={src} alt={alt} />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color:var(--bo-border)] py-1 pr-1.5 pl-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[var(--bo-muted)]">
          <Icon name="image" className="size-3.5 shrink-0" strokeWidth={1.5} />
          <span title={filename} className="truncate text-xs font-medium text-[var(--bo-fg)]">
            {filename}
          </span>
        </span>
        <span className="shrink-0">{action}</span>
      </span>
    </span>
  );
}
