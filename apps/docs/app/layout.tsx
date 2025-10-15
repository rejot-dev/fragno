import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider/next";

import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

import { defaultMetadata } from "@/lib/metadata";

export const metadata = {
  ...defaultMetadata,
  title: {
    // Landing page has no template as it's one page
    template: "Fragno: Build Full-Stack TypeScript Libraries",
    default: "Fragno",
  },
};
