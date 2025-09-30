import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider";
import type { Metadata } from "next";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s | Fragno",
    default: "Fragno",
  },
  description: "Fragno is the toolkit for building full-stack TypeScript libraries.",
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
