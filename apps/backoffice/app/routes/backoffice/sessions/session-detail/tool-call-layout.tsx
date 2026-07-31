import { useEffect, useState, type ReactNode } from "react";

export function ToolCallDetails({
  autoOpen,
  children,
  className,
  resetKey,
}: {
  autoOpen: boolean;
  children?: ReactNode;
  className: string;
  resetKey: string;
}) {
  const [open, setOpen] = useState(autoOpen);

  useEffect(() => {
    setOpen(autoOpen);
  }, [autoOpen, resetKey]);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className={className}
    >
      {children}
    </details>
  );
}

export function ToolResultSection({
  action,
  children,
  label,
}: {
  action?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <section>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}
