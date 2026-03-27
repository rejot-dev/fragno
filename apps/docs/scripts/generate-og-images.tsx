import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

import matter from "gray-matter";
import React from "react";
import type { ReactNode } from "react";
import satori from "satori";
import sharp from "sharp";

import { Resvg } from "@resvg/resvg-js";

const BLOG_DIR = join(import.meta.dirname, "../content/blog");
const OUTPUT_DIR = join(import.meta.dirname, "../public/og");
const PUBLIC_DIR = join(import.meta.dirname, "../public");

/**
 * OG image aspect ratios:
 *  - og:      1.91:1 (1200×630) — Facebook, LinkedIn, Discord, general Open Graph
 *  - twitter: 2:1    (1200×600) — Twitter/X summary_large_image
 */
const ASPECT_RATIOS = {
  og: { width: 1200, height: 630 },
  twitter: { width: 1200, height: 600 },
} as const;

type AspectRatioKey = keyof typeof ASPECT_RATIOS;
const RATIO_KEYS = Object.keys(ASPECT_RATIOS) as AspectRatioKey[];

interface BlogPost {
  slug: string;
  title: string;
  author: string;
  date: Date;
}

// ---------------------------------------------------------------------------
// Page OG registry — arbitrary pages with custom titles and labels
// ---------------------------------------------------------------------------

interface PageOgEntry {
  /** Output filename (without extension/ratio suffix), placed in public/og/ */
  filename: string;
  /** Large title rendered on the OG image */
  title: string;
  /** Small monospace label in the top-right, e.g. "Fragment // Resend" */
  label: string;
  /** Optional subtitle below the title */
  subtitle?: string;
}

const PAGE_REGISTRY: PageOgEntry[] = [
  {
    filename: "resend-essay",
    title: "Receiving Resend inbound email without webhooks",
    label: "Full-stack library // Resend",
    subtitle: "Inbound email as a full-stack library",
  },
];

// ---------------------------------------------------------------------------
// Editorial design tokens (dark mode)
// ---------------------------------------------------------------------------

const ED = {
  paper: "#111827",
  surface: "#162033",
  surfaceLow: "#1c2942",
  ink: "#e5eefb",
  muted: "#9fb0c8",
  primary: "#f66364",
  secondary: "#5ba4f9",
  tertiary: "#fcc433",
  ghostBorder: "rgba(226, 232, 240, 0.12)",
} as const;

// ---------------------------------------------------------------------------
// Fonts — Space Grotesk (static woff, matches site) + JetBrains Mono (monospace labels)
// Satori doesn't support variable fonts, so we fetch static instances from CDN.
// ---------------------------------------------------------------------------

async function loadFonts() {
  const [sgRegular, sgBold, monoRegular, monoBold] = await Promise.all([
    fetchFont(
      "https://cdn.jsdelivr.net/fontsource/fonts/space-grotesk@latest/latin-400-normal.woff",
    ),
    fetchFont(
      "https://cdn.jsdelivr.net/fontsource/fonts/space-grotesk@latest/latin-700-normal.woff",
    ),
    fetchFont(
      "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.woff",
    ),
    fetchFont(
      "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-600-normal.woff",
    ),
  ]);
  return [
    { name: "Space Grotesk", data: sgRegular, weight: 400 as const, style: "normal" as const },
    { name: "Space Grotesk", data: sgBold, weight: 700 as const, style: "normal" as const },
    { name: "JetBrains Mono", data: monoRegular, weight: 400 as const, style: "normal" as const },
    { name: "JetBrains Mono", data: monoBold, weight: 600 as const, style: "normal" as const },
  ];
}

async function fetchFont(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch font ${url}: ${res.status}`);
  }
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Blog post discovery
// ---------------------------------------------------------------------------

function getBlogPosts(): BlogPost[] {
  const files = readdirSync(BLOG_DIR).filter((f) => f.endsWith(".mdx") && !f.startsWith("."));

  return files.map((file) => {
    const content = readFileSync(join(BLOG_DIR, file), "utf-8");
    const { data } = matter(content);
    return {
      slug: basename(file, ".mdx"),
      title: data.title,
      author: data.author,
      date: new Date(data.date),
    };
  });
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function outPath(slug: string, ratio: AspectRatioKey): string {
  return join(OUTPUT_DIR, `${slug}-${ratio}.webp`);
}

// ---------------------------------------------------------------------------
// Adaptive title sizing
// ---------------------------------------------------------------------------

function titleFontSize(title: string): number {
  const len = title.length;
  if (len < 25) {
    return 62;
  }
  if (len < 45) {
    return 56;
  }
  if (len < 65) {
    return 50;
  }
  if (len < 85) {
    return 44;
  }
  return 38;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function PageRoad({ height }: { height: string }) {
  return (
    <div
      style={{
        display: "flex",
        position: "absolute",
        left: "0",
        top: "0",
        bottom: "0",
        width: "3px",
        height,
        backgroundImage: `linear-gradient(to bottom, ${ED.primary} 15%, ${ED.tertiary} 45%, ${ED.secondary} 75%, ${ED.primary} 100%)`,
      }}
    />
  );
}

function LogoMark() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        fontFamily: "JetBrains Mono",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: ED.primary,
        }}
      />
      <div
        style={{
          display: "flex",
          fontSize: 15,
          fontWeight: 600,
          color: ED.ink,
          letterSpacing: "0.04em",
        }}
      >
        Fragno
      </div>
    </div>
  );
}

function AccentDots() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <div
        style={{
          display: "flex",
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          backgroundColor: ED.primary,
        }}
      />
      <div
        style={{
          display: "flex",
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          backgroundColor: ED.tertiary,
        }}
      />
      <div
        style={{
          display: "flex",
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          backgroundColor: ED.secondary,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blog post template
// ---------------------------------------------------------------------------

function createOgImage(post: BlogPost): ReactNode {
  const fontSize = titleFontSize(post.title);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: ED.paper,
        fontFamily: "Space Grotesk",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <PageRoad height="100%" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "44px 72px 0 32px",
          justifyContent: "space-between",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <LogoMark />
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 13,
              fontWeight: 600,
              color: ED.muted,
              letterSpacing: "0.14em",
              textTransform: "uppercase" as const,
            }}
          >
            Blog
          </div>
        </div>

        {/* Title */}
        <div
          style={{
            display: "flex",
            fontSize,
            fontWeight: 700,
            color: ED.ink,
            lineHeight: 1.08,
            letterSpacing: "-0.035em",
            maxWidth: "980px",
            paddingLeft: "12px",
          }}
        >
          {post.title}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${ED.ghostBorder}`,
            padding: "22px 0 28px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              fontFamily: "JetBrains Mono",
              fontSize: 14,
              letterSpacing: "0.08em",
              textTransform: "uppercase" as const,
            }}
          >
            <div style={{ display: "flex", fontWeight: 600, color: ED.ink }}>{post.author}</div>
            <div style={{ display: "flex", color: ED.muted }}>·</div>
            <div style={{ display: "flex", fontWeight: 400, color: ED.muted }}>
              {formatDate(post.date)}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
            <div
              style={{
                display: "flex",
                fontFamily: "JetBrains Mono",
                fontSize: 14,
                fontWeight: 600,
                color: ED.muted,
                letterSpacing: "0.08em",
              }}
            >
              fragno.dev
            </div>
            <AccentDots />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main site OG template (social.webp)
// ---------------------------------------------------------------------------

function createMainOgImage(): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: ED.paper,
        fontFamily: "Space Grotesk",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <PageRoad height="100%" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "44px 72px 0 32px",
          justifyContent: "space-between",
        }}
      >
        {/* Header */}
        <LogoMark />

        {/* Title area */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            paddingLeft: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 14,
              fontWeight: 600,
              color: ED.primary,
              letterSpacing: "0.14em",
              textTransform: "uppercase" as const,
            }}
          >
            Full-stack library toolkit
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 72,
              fontWeight: 700,
              color: ED.ink,
              lineHeight: 0.96,
              letterSpacing: "-0.045em",
            }}
          >
            Build Full-Stack Libraries
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 16,
              fontWeight: 400,
              color: ED.muted,
              letterSpacing: "0.02em",
              lineHeight: 1.7,
              maxWidth: "680px",
            }}
          >
            Type-safe TypeScript libraries that embed backend, frontend, and data layer in your
            users' applications — across frameworks.
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${ED.ghostBorder}`,
            padding: "22px 0 28px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 14,
              fontWeight: 600,
              color: ED.muted,
              letterSpacing: "0.08em",
            }}
          >
            fragno.dev
          </div>
          <AccentDots />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page OG template (registry entries)
// ---------------------------------------------------------------------------

function createPageOgImage(entry: PageOgEntry): ReactNode {
  const fontSize = titleFontSize(entry.title);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: ED.paper,
        fontFamily: "Space Grotesk",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <PageRoad height="100%" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "44px 72px 0 32px",
          justifyContent: "space-between",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <LogoMark />
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 13,
              fontWeight: 600,
              color: ED.muted,
              letterSpacing: "0.14em",
              textTransform: "uppercase" as const,
            }}
          >
            {entry.label}
          </div>
        </div>

        {/* Title + optional subtitle */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            paddingLeft: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize,
              fontWeight: 700,
              color: ED.ink,
              lineHeight: 1.08,
              letterSpacing: "-0.035em",
              maxWidth: "980px",
            }}
          >
            {entry.title}
          </div>
          {entry.subtitle ? (
            <div
              style={{
                display: "flex",
                fontFamily: "JetBrains Mono",
                fontSize: 16,
                fontWeight: 400,
                color: ED.muted,
                letterSpacing: "0.02em",
                lineHeight: 1.7,
                maxWidth: "720px",
              }}
            >
              {entry.subtitle}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${ED.ghostBorder}`,
            padding: "22px 0 28px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 14,
              fontWeight: 600,
              color: ED.muted,
              letterSpacing: "0.08em",
            }}
          >
            fragno.dev
          </div>
          <AccentDots />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function renderToWebp(
  element: ReactNode,
  dimensions: { width: number; height: number },
  fonts: Awaited<ReturnType<typeof loadFonts>>,
): Promise<Buffer> {
  const svg = await satori(element, { ...dimensions, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: dimensions.width } });
  const pngBuffer = Buffer.from(resvg.render().asPng());
  return sharp(pngBuffer).webp({ quality: 90 }).toBuffer();
}

// ---------------------------------------------------------------------------
// --check: verify every blog post has its OG images
// ---------------------------------------------------------------------------

function runCheck(posts: BlogPost[]): boolean {
  let allGood = true;

  for (const entry of PAGE_REGISTRY) {
    for (const ratio of RATIO_KEYS) {
      const p = outPath(entry.filename, ratio);
      if (!existsSync(p)) {
        console.error(`Missing page: ${entry.filename}-${ratio}.webp`);
        allGood = false;
      }
    }
  }

  for (const post of posts) {
    for (const ratio of RATIO_KEYS) {
      const p = outPath(post.slug, ratio);
      if (!existsSync(p)) {
        console.error(`Missing blog: ${post.slug}-${ratio}.webp`);
        allGood = false;
      }
    }
  }

  const total = (PAGE_REGISTRY.length + posts.length) * RATIO_KEYS.length;
  if (allGood) {
    console.log(`All ${total} OG images present.`);
  }
  return allGood;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.includes("--force");
  const check = process.argv.includes("--check");
  const mainOnly = process.argv.includes("--main");
  const filterSlug = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];

  const allPosts = getBlogPosts();

  if (check) {
    const ok = runCheck(allPosts);
    process.exit(ok ? 0 : 1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const fonts = await loadFonts();

  // Generate main site OG image (social.webp)
  const socialPath = join(PUBLIC_DIR, "social.webp");
  if (mainOnly || force || !existsSync(socialPath)) {
    console.log("Generating main site OG image (social.webp)...");
    const mainElement = createMainOgImage();
    const mainBuffer = await renderToWebp(mainElement, ASPECT_RATIOS.og, fonts);
    writeFileSync(socialPath, mainBuffer);
    console.log("  ✓ social.webp\n");
  }

  if (mainOnly) {
    return;
  }

  // Generate page registry OG images
  const pagesToGenerate = PAGE_REGISTRY.filter((entry) => {
    if (force) {
      return true;
    }
    return RATIO_KEYS.some((ratio) => !existsSync(outPath(entry.filename, ratio)));
  });

  if (pagesToGenerate.length > 0) {
    console.log(`Generating OG images for ${pagesToGenerate.length} page(s)...`);
    for (const entry of pagesToGenerate) {
      const element = createPageOgImage(entry);
      for (const ratio of RATIO_KEYS) {
        const out = outPath(entry.filename, ratio);
        if (!force && existsSync(out)) {
          continue;
        }
        const webpBuffer = await renderToWebp(element, ASPECT_RATIOS[ratio], fonts);
        writeFileSync(out, webpBuffer);
      }
      console.log(`  ✓ ${entry.filename}`);
    }
    console.log();
  }

  const posts = filterSlug ? allPosts.filter((p) => p.slug === filterSlug) : allPosts;

  if (posts.length === 0) {
    console.log("No blog posts found.");
    return;
  }

  const postsToGenerate = posts.filter((post) => {
    if (force) {
      return true;
    }
    return RATIO_KEYS.some((ratio) => !existsSync(outPath(post.slug, ratio)));
  });

  if (postsToGenerate.length === 0) {
    console.log(
      `All ${posts.length} blog post OG images already exist. Use --force to regenerate.`,
    );
    return;
  }

  console.log(
    `Generating OG images for ${postsToGenerate.length}/${posts.length} post(s) ` +
      `(${RATIO_KEYS.map((k) => `${k}: ${ASPECT_RATIOS[k].width}×${ASPECT_RATIOS[k].height}`).join(", ")})\n`,
  );

  for (const post of postsToGenerate) {
    const element = createOgImage(post);

    for (const ratio of RATIO_KEYS) {
      const out = outPath(post.slug, ratio);
      if (!force && existsSync(out)) {
        continue;
      }

      const webpBuffer = await renderToWebp(element, ASPECT_RATIOS[ratio], fonts);
      writeFileSync(out, webpBuffer);
    }

    console.log(`  ✓ ${post.slug}`);
  }

  console.log(`\nDone — ${postsToGenerate.length * RATIO_KEYS.length} images in ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("OG image generation failed:", err);
  process.exit(1);
});
