import { useEffect, useState } from "react";

import { cn } from "../cn";
import { Icon } from "./icon";

const CONFIRMATION_MS = 1_500;

/**
 * A button that copies `value`, and briefly confirms it did. It shows only its icon unless
 * `labelled`, as when it sits beside another copy button and the reader must tell them apart.
 * A function `value` is built on click, for text that is costly to build.
 */
export function CopyButton({
  value,
  label,
  labelled,
}: {
  value: string | (() => string);
  label: string;
  labelled: boolean;
}) {
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
          .writeText(typeof value === "function" ? value() : value)
          .then(() => {
            setCopied(true);
          })
          .catch(() => {
            // Denied clipboard access leaves the button unconfirmed; there is nothing to recover.
          });
      }}
      className={cn(
        "relative inline-flex h-6 shrink-0 items-center justify-center rounded-[4px] text-[var(--bo-muted)] transition-[color,background-color,scale] duration-150 ease-out after:absolute after:-inset-1.5 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]",
        labelled ? "gap-1.5 px-1.5 text-[11px] font-medium" : "w-6",
      )}
    >
      <Icon
        name={copied ? "check" : "copy"}
        className={copied ? "size-3.5 text-[var(--bo-live)]" : "size-3.5"}
      />
      {labelled ? <span>{label}</span> : null}
    </button>
  );
}
