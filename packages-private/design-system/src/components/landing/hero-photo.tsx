import { type RefObject, useEffect, useRef, useState } from "react";

type HeroPhoto = {
  url: string;
  /** The photo's height when it is 1200 wide: the coordinate space its summits are given in. */
  height: number;
  /**
   * The summits the line runs between, left to right, read off the full-resolution photo at each
   * peak's highest point.
   */
  summits: readonly { x: number; y: number }[];
  /**
   * The photo's colors in five bands from top to bottom, averaged, then dimmed and saturated as its
   * look shows it. They are painted behind the photo, so the hero shows its sky while it loads.
   */
  placeholder: readonly [string, string, string, string, string];
  /** How the photo is shown, kept with it so a photo's tuned look stays as it was tuned. */
  look: HeroPhotoLook;
};

type HeroPhotoLook = {
  /** Brightness as a multiple of the photo's own: lower is darker. */
  brightness: number;
  blurPx: number;
  /**
   * How far the photo overhangs the hero above and below, as a percentage of the hero's height.
   * Overhanging more below moves the photo, and its summits, down. The drift moves the photo by up
   * to 3% of its own height, and its scale covers the rest, so 2% above still hides the top edge.
   */
  overhang: { above: number; below: number };
};

// The look the first photos were tuned with: lightly dimmed, barely softened, centered.
const FIRST_LOOK: HeroPhotoLook = {
  brightness: 0.85,
  blurPx: 1,
  overhang: { above: 10, below: 10 },
};

// Darker and softer than the first look, and lower, so the line runs under the heading. Tuned on
// "dolomites-fire".
const LOW_LOOK: HeroPhotoLook = {
  brightness: 0.68,
  blurPx: 3,
  overhang: { above: 2, below: 32 },
};

// Free under the Unsplash License.
const HERO_PHOTOS = {
  // Layered ridges under a violet and orange sunset: https://unsplash.com/photos/3xs5yZ1JBVA
  "sunset-ridges": {
    url: "https://images.unsplash.com/photo-1693253024090-1fc1e1821a5c?auto=format&fit=crop&w=2400&q=70",
    height: 675,
    placeholder: ["#a9968f", "#9e7867", "#785656", "#2f2a32", "#151821"],
    summits: [
      { x: 153, y: 286 },
      { x: 412, y: 312 },
      { x: 698, y: 291 },
      { x: 840, y: 344 },
      { x: 1137, y: 365 },
    ],
    look: FIRST_LOOK,
  },
  // Sunlit snowy peaks under a starry night sky: https://unsplash.com/photos/T5XK3KHFQUk
  "starry-peaks": {
    url: "https://images.unsplash.com/photo-1786698853398-6db3c7bdc4de?auto=format&fit=crop&w=2400&q=70",
    height: 800,
    placeholder: ["#162029", "#1a232c", "#21272e", "#3c3528", "#1f2117"],
    summits: [
      { x: 195, y: 568 },
      { x: 265, y: 520 },
      { x: 450, y: 487 },
      { x: 810, y: 458 },
      { x: 880, y: 453 },
      { x: 1176, y: 538 },
    ],
    look: FIRST_LOOK,
  },
  // Distant peaks rising from a sea of clouds at dawn: https://unsplash.com/photos/rV6BfVtFGf8
  "cloud-sea": {
    url: "https://images.unsplash.com/photo-1497551407056-6fde78960ff7?auto=format&fit=crop&w=2400&q=70",
    height: 801,
    placeholder: ["#738288", "#7b7d73", "#566464", "#4c5458", "#2f3a44"],
    summits: [
      { x: 119, y: 372 },
      { x: 433, y: 374 },
      { x: 589, y: 376 },
      { x: 797, y: 392 },
      { x: 1140, y: 428 },
    ],
    // The low look, lower still, so its distant peaks sit under the hero's buttons.
    look: { ...LOW_LOOK, overhang: { above: 2, below: 48 } },
  },
  // Jagged Dolomite peaks lit at sunrise under a fiery sky, cloud in the valleys:
  // https://unsplash.com/photos/u5QzsKvu7YA
  "dolomites-fire": {
    url: "https://images.unsplash.com/photo-1677696393693-d158fbef7d4b?auto=format&fit=crop&w=2400&q=70",
    height: 675,
    placeholder: ["#82494d", "#9f624d", "#733c33", "#492b28", "#3e2419"],
    summits: [
      { x: 68, y: 334 },
      { x: 324, y: 304 },
      { x: 478, y: 315 },
      { x: 721, y: 296 },
      { x: 914, y: 267 },
      { x: 1131, y: 279 },
    ],
    look: LOW_LOOK,
  },
  // Range after range of blue ridges fading into the haze under a pink dawn sky, Salzkammergut:
  // https://unsplash.com/photos/GswUraqZM6E. The summits are on the farthest range.
  "layered-dawn": {
    url: "https://images.unsplash.com/photo-1745334719497-e7fcaecb6ea5?auto=format&fit=crop&w=2400&q=70",
    height: 885,
    placeholder: ["#897d70", "#826b61", "#4d5e75", "#1b3953", "#131a20"],
    summits: [
      { x: 172, y: 409 },
      { x: 564, y: 416 },
      { x: 858, y: 431 },
      { x: 1027, y: 411 },
    ],
    // Higher than the clouds, so the far range sits under the hero's copy with the nearer ridges
    // in view below it.
    look: { ...LOW_LOOK, overhang: { above: 2, below: 32 } },
  },
  // Hazy ridges stepping back under a clear blue sky, Kastria, Greece:
  // https://unsplash.com/photos/1x6cs4B3IZk
  "clear-valley": {
    url: "https://images.unsplash.com/photo-1762036705777-a872d9171aa1?auto=format&fit=crop&w=2400&q=70",
    height: 801,
    placeholder: ["#85a0b1", "#94a6ae", "#606e77", "#3e4a53", "#262e35"],
    summits: [
      { x: 122, y: 267 },
      { x: 380, y: 315 },
      { x: 1017, y: 305 },
    ],
    // Its skyline is high in the frame, so it overhangs far below to bring the line under the copy;
    // a little brighter than the low look, so its sky stays blue.
    look: { ...LOW_LOOK, brightness: 0.82, overhang: { above: 2, below: 58 } },
  },
  // Snowy peaks around the Matterhorn under a clear, deep-blue sky:
  // https://unsplash.com/photos/L9kx2A3XhC0
  matterhorn: {
    url: "https://images.unsplash.com/photo-1645836137921-b6b06342ebe1?auto=format&fit=crop&w=2400&q=70",
    height: 476.5,
    placeholder: ["#153b6c", "#2d557f", "#606f80", "#707680", "#7b8088"],
    // Only the Matterhorn and the peaks right of it: the line from those to its left rises off the
    // top of the hero, clear of the heading, where the left peaks would carry it through the heading.
    summits: [
      { x: 762, y: 95 },
      { x: 996, y: 145 },
      { x: 1095, y: 175 },
    ],
    look: { ...LOW_LOOK, overhang: { above: 2, below: 32 } },
  },
  // Layered mountain silhouettes under a clear teal and golden sky:
  // https://unsplash.com/photos/edu_UJYxJBA
  "golden-silhouettes": {
    url: "https://images.unsplash.com/photo-1503601350100-26336a6beda2?auto=format&fit=crop&w=2400&q=70",
    height: 800,
    placeholder: ["#688085", "#7c7f7b", "#8c7761", "#383028", "#090808"],
    summits: [
      { x: 185, y: 478 },
      { x: 277, y: 472 },
      { x: 645, y: 488 },
      { x: 748, y: 512 },
      { x: 904, y: 509 },
      { x: 1176, y: 544 },
    ],
    // Its skyline is low in the frame already, so it overhangs more above than below, which raises
    // it to the middle of the hero. The drift pans it up by up to 3.5% of the hero, so 5% below
    // keeps its bottom edge hidden.
    look: { ...LOW_LOOK, overhang: { above: 19, below: 5 } },
  },
  // Fitz Roy and Cerro Torre's granite spires under a clear blue sky, Patagonia:
  // https://unsplash.com/photos/M6_OMo2bTvI
  "fitz-roy": {
    url: "https://images.unsplash.com/photo-1615213780624-97494a577778?auto=format&fit=crop&w=2400&q=70",
    height: 800,
    placeholder: ["#3e79ab", "#5182aa", "#5f7286", "#47494f", "#594934"],
    summits: [
      { x: 142, y: 274 },
      { x: 531, y: 300 },
      { x: 664, y: 229 },
      { x: 791, y: 176 },
      { x: 966, y: 293 },
      { x: 1041, y: 316 },
    ],
    // Its spires stand high in the frame, so it overhangs far below to bring them under the copy.
    // Brighter and sharper than the low look, so it reads as clear golden-hour light.
    look: { ...LOW_LOOK, brightness: 0.82, blurPx: 1, overhang: { above: 2, below: 80 } },
  },
} satisfies Record<string, HeroPhoto>;

// Each summit's marker, in screen pixels: a ring this wide, and the line's gap around it. They are
// drawn as zero-length round strokes that do not scale, so they stay this size however large the
// photo is shown.
const MARKER_SIZE = 9;
const MARKER_GAP = 13;

/** A dot `size` screen pixels across at `point`, as a zero-length stroke with a round cap. */
function Dot({
  point,
  size,
  color,
}: {
  point: { x: number; y: number };
  size: number;
  color: string;
}) {
  return (
    <path
      d={`M${point.x} ${point.y}h0`}
      stroke={color}
      strokeWidth={size}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * Keeps a flash moving along the line, each run unlike the last: 2.5 to 5.5s to cross at a steady
 * speed, and one run in three going right to left. Each run starts as the last one leaves, so the
 * light never stops; the first starts as soon as the line has faded in with the photo. Off for
 * reduced motion, where the flash stays out of sight.
 */
function useRandomFlashes(flashRef: RefObject<SVGPolylineElement | null>, photoLoaded: boolean) {
  useEffect(() => {
    const flash = flashRef.current;
    if (!flash || !photoLoaded || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout>;
    let run: Animation | null = null;
    function scheduleRun(target: SVGPolylineElement, delay: number) {
      timer = setTimeout(() => {
        // The dash rests at 0.08, before the first summit, and leaves past the last at -1.
        const leftToRight = Math.random() < 2 / 3;
        const offsets = leftToRight ? [0.08, -1] : [-1, 0.08];
        run = target.animate(
          offsets.map((offset) => ({ strokeDashoffset: offset })),
          { duration: 2500 + Math.random() * 3000, easing: "linear" },
        );
        run.onfinish = () => {
          scheduleRun(target, 0);
        };
      }, delay);
    }
    // The line fades in over 1.7s after the photo loads (components.css), so the first run waits
    // for it to show.
    scheduleRun(flash, 1700);
    return () => {
      clearTimeout(timer);
      run?.cancel();
    };
  }, [flashRef, photoLoaded]);
}

/**
 * The line through the summits, run on straight past the first and the last to the photo's left and
 * right edges. The photo overhangs the hero, so its edges, and the line's ends, are always off screen.
 */
function lineThrough(summits: HeroPhoto["summits"]) {
  const [first, second] = summits;
  const [beforeLast, last] = summits.slice(-2);
  return [
    { x: 0, y: first.y - (first.x * (second.y - first.y)) / (second.x - first.x) },
    ...summits,
    { x: 1200, y: last.y + ((1200 - last.x) * (last.y - beforeLast.y)) / (last.x - beforeLast.x) },
  ];
}

/**
 * The hero's photo, drifting slowly, with a faint line from summit to summit across it and a dot on
 * each summit. Every few seconds a single flash of light runs along the line. The line and dots ride
 * on the photo, so they stay on the peaks as it moves. Until the photo loads, its placeholder colors
 * show, and the photo and the line then fade in. It fills its positioned parent and overhangs it on
 * every side, so the parent clips it.
 */
export function LandingHeroPhoto({ photo }: { photo: keyof typeof HERO_PHOTOS }) {
  const { url, height, summits, placeholder, look }: HeroPhoto = HERO_PHOTOS[photo];
  // Names the line's gradient and mask; the photo's name keeps them apart when several photos are
  // on one page, as in Storybook.
  const id = `landing-ley-${photo}`;
  const points = lineThrough(summits)
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
  // The photo and its line fade in once it has loaded, over its placeholder colors.
  const [loaded, setLoaded] = useState(false);
  const flashRef = useRef<SVGPolylineElement>(null);
  useRandomFlashes(flashRef, loaded);
  return (
    <>
      {/* The placeholder colors lie still behind the drifting photo rather than on it: a browser can
          show the moving layer late when it scrolls back into view, and the hero then shows the
          photo's colors instead of its dark background. */}
      <div
        className="landing-hero-photo-placeholder"
        style={{
          top: `-${look.overhang.above}%`,
          bottom: `-${look.overhang.below}%`,
          background: `linear-gradient(to bottom, ${placeholder.join(", ")})`,
        }}
      />
      <div
        className="landing-hero-photo"
        data-loaded={loaded || undefined}
        style={{ top: `-${look.overhang.above}%`, bottom: `-${look.overhang.below}%` }}
      >
        <img
          src={url}
          alt=""
          decoding="async"
          fetchPriority="high"
          onLoad={() => {
            setLoaded(true);
          }}
          // A photo already in the cache can finish loading before React listens for it, so a
          // complete one counts as loaded straight away.
          ref={(image) => {
            if (image?.complete && image.naturalWidth > 0) {
              setLoaded(true);
            }
          }}
          // Graded like golden hour: a little sepia warms the rock without greying the blue sky,
          // and softer contrast keeps it light. The sunlight on the peaks lies over it
          // (components.css).
          style={{
            filter: `brightness(${look.brightness}) sepia(0.18) saturate(1.15) contrast(0.92) blur(${look.blurPx}px)`,
          }}
        />
        {/* Under the line, so the shade that keeps the copy readable does not dim the flash. */}
        <div className="landing-hero-photo-shade" />
        {/* Scaled and cropped exactly as the photo is, so its coordinates land on the peaks. */}
        <svg viewBox={`0 0 1200 ${height}`} preserveAspectRatio="xMidYMid slice" fill="none">
          <defs>
            {/* The line fades in from the photo's left edge and out to its right, so it trails off
              past the screen's sides instead of stopping. */}
            <linearGradient
              id={`${id}-fade`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1="0"
              x2="1200"
              y2="0"
            >
              <stop offset="0.04" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.2" stopColor="#ffffff" />
              <stop offset="0.8" stopColor="#ffffff" />
              <stop offset="0.96" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            {/* Cuts the line around each summit, so it meets the marker's ring with a small gap. */}
            <mask
              id={`${id}-gaps`}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="1200"
              height={height}
            >
              <rect width="1200" height={height} fill="#ffffff" />
              {summits.map((summit) => (
                <Dot key={summit.x} point={summit} size={MARKER_GAP} color="#000000" />
              ))}
            </mask>
            {/* Hollows each marker's disc into a 1px ring. */}
            <mask
              id={`${id}-rings`}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="1200"
              height={height}
            >
              <rect width="1200" height={height} fill="#ffffff" />
              {summits.map((summit) => (
                <Dot key={summit.x} point={summit} size={MARKER_SIZE - 2} color="#000000" />
              ))}
            </mask>
          </defs>
          <g mask={`url(#${id}-gaps)`}>
            <polyline
              points={points}
              className="landing-ley-line"
              stroke={`url(#${id}-fade)`}
              strokeWidth="1"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* The flash is a dash 0.08 of the line long, measured with pathLength, so it keeps its
              share of the line however the photo is scaled; like the line, it keeps its thickness. */}
            <polyline
              points={points}
              pathLength={1}
              ref={flashRef}
              className="landing-ley-flash"
              stroke={`url(#${id}-fade)`}
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="0.08 1"
              vectorEffect="non-scaling-stroke"
            />
          </g>
          {/* A survey marker on each summit: a solid point inside a thin ring. */}
          <g className="landing-ley-summit">
            <g mask={`url(#${id}-rings)`} opacity="0.6">
              {summits.map((summit) => (
                <Dot key={summit.x} point={summit} size={MARKER_SIZE} color="#ffffff" />
              ))}
            </g>
            {summits.map((summit) => (
              <Dot key={summit.x} point={summit} size={3.2} color="#ffffff" />
            ))}
          </g>
        </svg>
      </div>
      {/* A day's light passing over the photo (components.css). */}
      <div className="landing-hero-light landing-hero-light-golden" />
      <div className="landing-hero-light landing-hero-light-dusk" />
      <div className="landing-hero-light landing-hero-light-dawn" />
      <div className="landing-hero-light landing-hero-light-day" />
    </>
  );
}
