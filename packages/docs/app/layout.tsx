import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

const baseUrl =
  process.env.NODE_ENV === "development"
    ? new URL("http://localhost:3000")
    : new URL(`https://fragno.dev`);

export const metadata: Metadata = {
  title: {
    template: "%s | Fragno",
    default: "Fragno",
  },
  description: "Fragno is the toolkit for building full-stack TypeScript libraries.",
  metadataBase: baseUrl,
  openGraph: {
    images: "/social.webp",
  },
  twitter: {
    card: "summary_large_image",
    images: "/social.webp",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
