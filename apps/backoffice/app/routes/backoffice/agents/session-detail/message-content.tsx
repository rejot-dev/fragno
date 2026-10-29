import { ImagePreview } from "@fragno-private/design-system/image-preview";
import type { ComponentProps, ComponentType } from "react";
import { Streamdown } from "streamdown";

import { FileImage, FileLink, ScopedFileLink } from "@/components/backoffice/file-scope";

import { rehypePlugins, remarkPlugins } from "./file-path-links";

const markdownComponents = {
  img: MarkdownImage,
  // Only rehypeFileDestinations creates these elements, and only with a validated path and scope.
  "file-link": FileLink as ComponentType,
  "scoped-file-link": ScopedFileLink as ComponentType,
  "file-image": FileImage as ComponentType,
  "unavailable-image": MarkdownImage,
};

function MarkdownImage({ src, alt = "" }: ComponentProps<"img">) {
  return <ImagePreview src={typeof src === "string" && src ? src : null} alt={alt} />;
}

export function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <Streamdown
      mode="streaming"
      className={`bo-session-markdown text-pretty ${className}`}
      controls={{ code: true, table: true }}
      components={markdownComponents}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      skipHtml
    >
      {text}
    </Streamdown>
  );
}

export function MessageImage({ image }: { image: string }) {
  return <ImagePreview src={image} alt="Message attachment" />;
}
