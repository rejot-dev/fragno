// FNV-1a keeps the hue stable across sessions and spreads similar seeds apart.
function seedHue(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/**
 * A colour derived from seed. Pass a stable identity (not a display name) to keep the colour
 * across renames. Fixed lightness and chroma keep every hue equally prominent and legible under a
 * white mark.
 */
export function seededColor(seed: string) {
  return `oklch(0.62 0.14 ${seedHue(seed)})`;
}
