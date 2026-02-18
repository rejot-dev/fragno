import React from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import matter from "gray-matter";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { ReactNode } from "react";

const BLOG_DIR = join(import.meta.dirname, "../content/blog");
const OUTPUT_DIR = join(import.meta.dirname, "../public/og");

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
// Fonts — Outfit: geometric, modern, distinctive
// ---------------------------------------------------------------------------

async function loadFonts() {
  const [regular, bold] = await Promise.all([
    fetch("https://cdn.jsdelivr.net/fontsource/fonts/outfit@latest/latin-400-normal.woff").then(
      (res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch Outfit 400: ${res.status}`);
        }
        return res.arrayBuffer();
      },
    ),
    fetch("https://cdn.jsdelivr.net/fontsource/fonts/outfit@latest/latin-700-normal.woff").then(
      (res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch Outfit 700: ${res.status}`);
        }
        return res.arrayBuffer();
      },
    ),
  ]);
  return [
    { name: "Outfit", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Outfit", data: bold, weight: 700 as const, style: "normal" as const },
  ];
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
// Adaptive title sizing — bigger now that description is removed
// ---------------------------------------------------------------------------

function titleFontSize(title: string): number {
  const len = title.length;
  if (len < 25) {
    return 64;
  }
  if (len < 45) {
    return 58;
  }
  if (len < 65) {
    return 52;
  }
  if (len < 85) {
    return 46;
  }
  return 40;
}

// ---------------------------------------------------------------------------
// Template
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
        backgroundColor: "#070b14",
        fontFamily: "Outfit",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Top accent bar */}
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "5px",
          backgroundColor: "#30c2e0",
        }}
      />

      {/* Content — three rows: header, title (centered), footer */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "40px 72px 0",
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
          <div
            style={{
              display: "flex",
              fontSize: 18,
              fontWeight: 700,
              color: "#8898b0",
              letterSpacing: "0.08em",
              textTransform: "uppercase" as const,
            }}
          >
            Fragno: full-stack library toolkit
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 16,
              fontWeight: 400,
              color: "#6b7a94",
              letterSpacing: "0.06em",
              textTransform: "uppercase" as const,
            }}
          >
            Blog Post
          </div>
        </div>

        {/* Title — vertically centered between header and footer */}
        <div style={{ display: "flex", flexDirection: "row", gap: "28px", alignItems: "center" }}>
          {/* Vertical accent */}
          <div
            style={{
              display: "flex",
              width: "5px",
              alignSelf: "stretch",
              borderRadius: "3px",
              backgroundColor: "#30c2e0",
            }}
          />
          {/* Title text */}
          <div
            style={{
              display: "flex",
              fontSize,
              fontWeight: 700,
              color: "#ffffff",
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
              maxWidth: "960px",
            }}
          >
            {post.title}
          </div>
        </div>

        {/* Footer — distinct background strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "#131a28",
            margin: "0 -72px",
            padding: "20px 72px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                display: "flex",
                fontSize: 20,
                fontWeight: 700,
                color: "#d0d8e8",
              }}
            >
              {post.author}
            </div>
            <div style={{ display: "flex", fontSize: 20, color: "#4a5568" }}>·</div>
            <div
              style={{
                display: "flex",
                fontSize: 20,
                fontWeight: 400,
                color: "#8898b0",
              }}
            >
              {formatDate(post.date)}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              fontWeight: 700,
              color: "#8898b0",
              letterSpacing: "0.02em",
            }}
          >
            fragno.dev
          </div>
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

  for (const post of posts) {
    for (const ratio of RATIO_KEYS) {
      const p = outPath(post.slug, ratio);
      if (!existsSync(p)) {
        console.error(`Missing: ${post.slug}-${ratio}.webp`);
        allGood = false;
      }
    }
  }

  if (allGood) {
    console.log(`All ${posts.length * RATIO_KEYS.length} OG images present.`);
  }
  return allGood;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.includes("--force");
  const check = process.argv.includes("--check");
  const filterSlug = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];

  const allPosts = getBlogPosts();

  if (check) {
    const ok = runCheck(allPosts);
    process.exit(ok ? 0 : 1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

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

  const fonts = await loadFonts();

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
