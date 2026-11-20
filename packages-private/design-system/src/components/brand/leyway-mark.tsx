/**
 * The Leyway mark: a broad pink mountain in front of a smaller yellow one, each a single flat
 * plane, standing on a line of ground. The pink one covers the yellow one's left flank, so the two
 * stand one behind the other. Its colors are its own, the same on light and dark surfaces: the
 * ground is violet, opposite the yellow and beside the pink. Shown before the wordmark, as
 * tall as its lowercase (480 of its 920 units) and centered on the "l", as the wordmark centers
 * itself in a row. `className` sets its height.
 * Decorative: the links around it carry the name.
 */
export function LeywayMark({ className }: { className: string }) {
  return (
    <svg viewBox="-34 0 433.4 328" aria-hidden="true" className={`block shrink-0 ${className}`}>
      {/* The back mountain is drawn only where it shows: its left flank stops where it meets the
          front one's right flank. */}
      <path d="M250 70L360 260H280L210.1 138.8Z" fill="#ffd60a" />
      <path d="M130 0L280 260H0Z" fill="#ff2d87" />
      {/* The ground's ends carry on the outer flanks, the front one's left and the back one's
          right, so the mountains run down into it. */}
      <path d="M0 260H360L399.4 328H-34Z" fill="#7a3cff" />
    </svg>
  );
}
