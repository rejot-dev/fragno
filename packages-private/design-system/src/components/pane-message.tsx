import { Spinner } from "./spinner";

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

/** A spinner centered in an otherwise empty pane while its content loads. */
export function PaneSpinner({ label }: { label: string }) {
  return (
    // min-h keeps room for the spinner where the pane is not a flex column that grows it.
    <div role="status" className="flex min-h-24 flex-1 items-center justify-center">
      <Spinner />
      <span className="sr-only">{label}</span>
    </div>
  );
}
