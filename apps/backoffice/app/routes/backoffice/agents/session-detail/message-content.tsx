import {
  MarkdownImage,
  MarkdownText as ChatMarkdownText,
} from "@fragno-private/backoffice-chat/messages/markdown";
import type { ComponentType } from "react";

import {
  FileImage,
  FileLink,
  ScopedFileImage,
  ScopedFileLink,
} from "@/components/backoffice/file-scope";

import { rehypePlugins, remarkPlugins } from "./file-path-links";

const markdownComponents = {
  img: MarkdownImage,
  // Only rehypeFileDestinations creates these elements, and only with a validated path and scope.
  "file-link": FileLink as ComponentType,
  "scoped-file-link": ScopedFileLink as ComponentType,
  "file-image": FileImage as ComponentType,
  "scoped-file-image": ScopedFileImage as ComponentType,
  "unavailable-image": MarkdownImage,
};

/** Markdown whose workspace paths link to, and show, the scope's files. */
export function MarkdownText({ text, className }: { text: string; className?: string }) {
  return (
    <ChatMarkdownText
      text={text}
      className={className}
      components={markdownComponents}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    />
  );
}
