/** A single line centered in an otherwise empty pane, such as while its content loads. */
export function PaneMessage({ tone, children }: { tone: "muted" | "failed"; children: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4">
      <p
        role={tone === "failed" ? "alert" : "status"}
        className={`max-w-md text-sm text-pretty ${
          tone === "failed" ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted)]"
        }`}
      >
        {children}
      </p>
    </div>
  );
}
