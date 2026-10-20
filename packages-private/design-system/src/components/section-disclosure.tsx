import { useState, type ReactNode } from "react";

/** A labelled section shown on demand. Its body mounts only while open, so costly content waits. */
export function SectionDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className="group/section border border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 marker:hidden">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </span>
        <span className="text-[10px] font-medium tracking-[0.1em] text-[var(--bo-muted-2)] uppercase">
          <span className="group-open/section:hidden">Show</span>
          <span className="hidden group-open/section:inline">Hide</span>
        </span>
      </summary>
      {open ? <div className="border-t border-[color:var(--bo-border)] p-2">{children}</div> : null}
    </details>
  );
}
