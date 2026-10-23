/** The small ring every loading state shows; the surrounding status names what is loading. */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 animate-spin rounded-full border-[1.5px] border-[color:var(--bo-border-strong)] border-t-[color:var(--bo-fg)]"
    />
  );
}
