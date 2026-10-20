import { useEffect, useState } from "react";

import { Icon } from "./icon";

const CONFIRMATION_MS = 1_500;

/** An icon button that copies `value`, and briefly confirms it did. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setCopied(false);
    }, CONFIRMATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
          })
          .catch(() => {
            // Denied clipboard access leaves the button unconfirmed; there is nothing to recover.
          });
      }}
      className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-[4px] text-[var(--bo-muted)] transition-[color,background-color,scale] duration-150 ease-out after:absolute after:-inset-1.5 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
    >
      <Icon
        name={copied ? "check" : "copy"}
        className={copied ? "size-3.5 text-[var(--bo-live)]" : "size-3.5"}
      />
    </button>
  );
}
