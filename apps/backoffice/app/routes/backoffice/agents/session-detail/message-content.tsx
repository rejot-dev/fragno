import { ImagePreview } from "@fragno-private/design-system/image-preview";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";

import { FileImage } from "@/components/backoffice/file-image";

const markdownComponents = { img: MarkdownImage };

function MarkdownImage({ src, alt = "" }: ComponentProps<"img">) {
  // Markdown destinations are URI-encoded; collection keys are literal file paths.
  if (typeof src === "string" && /^\/(?:workspace|static|system)\//.test(src)) {
    let path: string;
    try {
      path = decodeURIComponent(src);
    } catch {
      return <ImagePreview src={null} alt={alt} />;
    }
    return <FileImage path={path} alt={alt} />;
  }
  return <ImagePreview src={typeof src === "string" && src ? src : null} alt={alt} />;
}

export function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <Streamdown
      mode="streaming"
      className={`bo-session-markdown text-pretty ${className}`}
      controls={{ code: true, table: true }}
      components={markdownComponents}
      skipHtml
    >
      {text}
    </Streamdown>
  );
}

export function MessageImage({ image }: { image: string }) {
  return <ImagePreview src={image} alt="Message attachment" />;
}

export function ScrollablePre({
  children,
  expanded = false,
}: {
  children: string;
  expanded?: boolean;
}) {
  return (
    <pre
      className={`${expanded ? "max-h-[70vh] min-h-64" : "max-h-72"} backoffice-scroll max-w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--bo-fg)]`}
    >
      {children}
    </pre>
  );
}
