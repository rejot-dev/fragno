import { createContext, useContext, type ComponentType, type ReactNode } from "react";

type MarkdownTextComponent = ComponentType<{ text: string }>;

/** Outside Backoffice, such as in Storybook, Markdown shows as its source text. */
function PlainMarkdownText({ text }: { text: string }) {
  return <p className="text-xs leading-5 whitespace-pre-wrap text-[var(--bo-fg)]">{text}</p>;
}

const MarkdownTextContext = createContext<MarkdownTextComponent>(PlainMarkdownText);

/**
 * Renders generated Markdown as the host renders its own, so workspace paths in it link to and
 * show the scope's files.
 */
export function MarkdownTextProvider({
  component,
  children,
}: {
  component: MarkdownTextComponent;
  children: ReactNode;
}) {
  return <MarkdownTextContext value={component}>{children}</MarkdownTextContext>;
}

export function useMarkdownText(): MarkdownTextComponent {
  return useContext(MarkdownTextContext);
}
