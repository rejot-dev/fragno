import { ImagePreview } from "@fragno-private/design-system/files/image-preview";
import type { ComponentProps } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";

export function MarkdownImage({ src, alt = "" }: ComponentProps<"img">) {
  return <ImagePreview src={typeof src === "string" && src ? src : null} alt={alt} />;
}

const plainComponents = { img: MarkdownImage };

function asksBeforeEveryLink() {
  return false;
}

/**
 * Markdown as the chat shows it, while it streams in. A host whose Markdown links its own files
 * passes the plugins that find them and the components that show them. Links ask before they open
 * another site, unless `opensWithoutAsking` says the host serves it.
 */
export function MarkdownText({
  text,
  className = "",
  components = plainComponents,
  remarkPlugins,
  rehypePlugins,
  opensWithoutAsking = asksBeforeEveryLink,
}: {
  text: string;
  className?: string;
  components?: StreamdownProps["components"];
  remarkPlugins?: StreamdownProps["remarkPlugins"];
  rehypePlugins?: StreamdownProps["rehypePlugins"];
  opensWithoutAsking?: (url: string) => boolean;
}) {
  return (
    <Streamdown
      mode="streaming"
      className={`bo-session-markdown text-pretty ${className}`}
      controls={{ code: true, table: true }}
      components={components}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      linkSafety={{ enabled: true, onLinkCheck: opensWithoutAsking }}
      skipHtml
    >
      {text}
    </Streamdown>
  );
}

export function MessageImage({ image }: { image: string }) {
  return <ImagePreview src={image} alt="Message attachment" />;
}
