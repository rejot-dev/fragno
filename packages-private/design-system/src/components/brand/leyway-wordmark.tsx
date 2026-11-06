/**
 * The Leyway wordmark: "leyway" set in Satoshi Regular, then "AI" in capitals a little taller than
 * its lowercase (540 units against 484), on the same baseline. "AI" is cut from the Medium, whose
 * strokes, scaled down to that size, are about as thick as the Regular's. Outlined. It takes the
 * surrounding text color; `className` sets its height. Its box reaches down to the descenders of
 * the "y"s, below the baseline, so it is drawn lower by the share of its height that centers the
 * "l" (729 of 947 units, from the top) where the box's center is: centered in a row, the letters
 * sit centered, and the descenders hang below.
 * Decorative: the links around it carry the name.
 */
export function LeywayWordmark({ className }: { className: string }) {
  return (
    <svg
      viewBox="75 -729 3603 947"
      aria-hidden="true"
      className={`block shrink-0 translate-y-[11.51%] ${className}`}
    >
      <g transform="scale(1,-1)" fill="currentColor">
        <path d="M144 0H75V729H144Z" />
        <path
          transform="translate(219 0)"
          d="M275 -12Q169 -12 103.5 58.0Q38 128 38 242Q38 355 102.5 426.0Q167 497 270 497Q368 497 429.0 433.5Q490 370 490 267V233H105Q109 144 153.5 95.5Q198 47 276 47Q396 47 424 145H490Q470 68 415.0 28.0Q360 -12 275 -12ZM107 283H421Q421 353 379.5 395.5Q338 438 270.0 438.0Q202 438 159.0 396.5Q116 355 107 283Z"
        />
        <path transform="translate(735 0)" d={Y_PATH} />
        <path
          transform="translate(1206 0)"
          d="M174 0 14 484H85L180 192Q193 154 210 88Q217 121 239 192L335 484H406L501 192Q515 150 531 88Q547 153 560 192L656 484H728L564 0H497L397 304Q380 354 371 399Q357 347 343 304L243 0Z"
        />
        <path
          transform="translate(1927 0)"
          d="M211 -12Q135 -12 91.0 27.0Q47 66 47 131Q47 197 95.0 237.5Q143 278 228 285L388 298V314Q388 439 260 439Q197 439 161.5 412.0Q126 385 126 336H63Q63 409 117.5 453.0Q172 497 262 497Q350 497 403.0 451.0Q456 405 456 313V0H398L389 85Q366 39 319.0 13.5Q272 -12 211 -12ZM227 44Q302 44 345.0 92.0Q388 140 388 220V246L245 235Q117 224 117 133Q117 90 146.5 67.0Q176 44 227 44Z"
        />
        <path transform="translate(2438 0)" d={Y_PATH} />
        {/* Closer than a word space, so "AI" reads as part of the name, and fainter, so the name
            leads. */}
        <g transform="translate(3048 0) scale(0.7469)" opacity={0.6}>
          <path d="M114 0H12L276 723H385L650 0H547L482 180H178ZM318 567 208 265H453L342 567Q333 592 330 609Q327 594 318 567Z" />
          <path transform="translate(662 0)" d="M182 723V0H84V723Z" />
        </g>
      </g>
    </svg>
  );
}

// Both "y"s share one glyph.
const Y_PATH =
  "M23 -211V-154H76Q96 -154 108.0 -152.5Q120 -151 136.0 -144.5Q152 -138 163.5 -123.5Q175 -109 184 -86L205 -29L9 484H82L238 62L391 484H462L240 -111Q201 -218 96 -218Q54 -218 23 -211Z";
