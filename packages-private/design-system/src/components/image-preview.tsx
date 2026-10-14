import { useState } from "react";

type ImagePreviewProps = {
  src: string | null;
  alt: string;
};

export function ImagePreview({ src, alt }: ImagePreviewProps) {
  return <ImagePreviewContent key={src} src={src} alt={alt} />;
}

function ImagePreviewContent({ src, alt }: ImagePreviewProps) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) {
    return (
      <span
        role="img"
        aria-label={alt}
        className="inline-flex max-w-full border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-3 text-xs text-[var(--bo-muted)]"
      >
        Image unavailable{alt ? `: ${alt}` : ""}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailed(true);
      }}
      className="inline-block max-h-96 max-w-full object-contain align-middle outline -outline-offset-1 outline-black/10 dark:outline-white/10"
    />
  );
}
