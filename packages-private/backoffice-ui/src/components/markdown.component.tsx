import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useMarkdownText } from "../markdown-text";

export function Markdown({
  props,
}: Parameters<ComponentFn<typeof backofficeUiCatalog, "Markdown">>[0]) {
  const MarkdownText = useMarkdownText();
  return <MarkdownText text={props.text} />;
}
