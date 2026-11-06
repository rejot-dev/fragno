/** The agent's mark: a round badge with an "A" and a text cursor, as the top bar's agent button. */
export function AgentMark() {
  return (
    <span className="flex size-8 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--bo-accent)_-40%,var(--bo-fg)_65%)] text-xs leading-none font-bold tracking-tight text-[var(--bo-panel)] shadow-md ring-4 inset-shadow-[0_1px_0_rgb(255_255_255/0.25)] ring-[color:var(--bo-fg)]/15">
      A
      <svg
        viewBox="0 0 8 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="ml-px h-[0.78em] w-auto"
        aria-hidden="true"
      >
        <path d="M1.5 1.5c1.5 0 2.5.5 2.5 2 0-1.5 1-2 2.5-2M4 3.5v9M1.5 14.5c1.5 0 2.5-.5 2.5-2 0 1.5 1 2 2.5 2" />
      </svg>
    </span>
  );
}
