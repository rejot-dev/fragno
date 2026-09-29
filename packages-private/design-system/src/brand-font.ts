// Same file the @font-face in theme.css points at, so a preload link fetches the exact asset the
// first paint needs instead of letting the page render in the fallback font and swap later.
import brandFontLatinUrl from "@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2?url";

export { brandFontLatinUrl };
