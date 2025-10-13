import type { Metadata } from "next";
const baseUrl =
  process.env.NODE_ENV === "development"
    ? new URL("http://localhost:3000")
    : new URL(`https://fragno.dev`);

export const defaultMetadata: Metadata = {
  description:
    "Fragno is the toolkit for building full-stack TypeScript libraries that work seamlessly across frameworks",
  metadataBase: baseUrl,
  openGraph: {
    images: "/social.webp",
  },
  twitter: {
    card: "summary_large_image",
    images: "/social.webp",
  },
};
