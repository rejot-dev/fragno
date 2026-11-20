/**
 * A thin bar for loading that has no measurable progress: a slanted segment slides across a track
 * whose ends are cut on the same slant as the brand's mark and the landing page's call to action.
 * `label` names what is loading for assistive technology. It fills its container's width.
 */
export function LoadingBar({ label }: { label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-busy="true"
      // The ends lean as far as the 24.83° slant takes the bar's 6px height.
      className="relative h-1.5 w-full overflow-hidden bg-[var(--bo-border)] [clip-path:polygon(2.8px_0,100%_0,calc(100%-2.8px)_100%,0_100%)]"
    >
      <span
        aria-hidden="true"
        className="bo-loading-bar-segment absolute inset-y-0 left-[35%] w-[30%] bg-[var(--bo-fg)]"
      />
    </div>
  );
}
