// FNV-1a keeps the hue stable across sessions and spreads similar seeds apart.
function seedHash(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// The Leyway mark's hues in OKLCH, going the way the colour wheel runs: from its violet (289°)
// through its pink (2°) to its yellow (95°).
const LOGO_HUE_START = 289;
const LOGO_HUE_SPAN = 166;

/**
 * A colour derived from seed. Pass a stable identity (not a display name) to keep the colour
 * across renames. Fixed lightness and chroma keep every hue equally prominent and legible under a
 * white mark.
 */
export function seededColor(seed: string) {
  return `oklch(0.62 0.14 ${seedHash(seed) % 360})`;
}

/** As seededColor, with the hue kept within the Leyway mark's range, violet through pink to yellow. */
export function seededLogoColor(seed: string) {
  return `oklch(0.62 0.14 ${(LOGO_HUE_START + (seedHash(seed) % LOGO_HUE_SPAN)) % 360})`;
}
