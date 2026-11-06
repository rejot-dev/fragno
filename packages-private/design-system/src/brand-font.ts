// The same files the @font-face rules in theme.css point at, so a preload link fetches the exact
// asset the first paint needs instead of letting the page render in the fallback font and swap later.
import brandFontLatinUrl from "@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2?url";
import headingFontLatinUrl from "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?url";

export { brandFontLatinUrl, headingFontLatinUrl };
