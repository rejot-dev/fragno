import { Check, Image, Palette } from "lucide-react";
import { useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";

import { BannerOgImage } from "../../og-image/banner-og-image";
import { OriginalOgImage } from "../../og-image/original-og-image";

export function loader() {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }
  return null;
}

export default function OgImagePage() {
  const [imageType, setImageType] = useState<"main" | "blog">("main");

  return (
    <div className="relative">
      <div className="absolute top-4 right-4 z-20 flex flex-col gap-3">
        <ThemeToggle />

        <div className="bg-background/95 border-border/50 flex flex-col gap-1 border p-3 shadow-xl backdrop-blur-md">
          <div className="text-muted-foreground flex items-center gap-2 px-1 py-1 text-xs font-semibold">
            <Image className="h-3 w-3" />
            Image Type
          </div>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setImageType("main")}
              className={`flex items-center justify-between px-3 py-2 text-sm font-medium transition-all duration-200 ${
                imageType === "main"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "hover:bg-muted/50 text-foreground"
              }`}
            >
              <div className="flex items-center gap-2">
                <Palette className="h-3.5 w-3.5" />
                Main (social.webp)
              </div>
              {imageType === "main" && <Check className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={() => setImageType("blog")}
              className={`flex items-center justify-between px-3 py-2 text-sm font-medium transition-all duration-200 ${
                imageType === "blog"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "hover:bg-muted/50 text-foreground"
              }`}
            >
              <div className="flex items-center gap-2">
                <Image className="h-3.5 w-3.5" />
                Blog Post
              </div>
              {imageType === "blog" && <Check className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {imageType === "blog" ? <OriginalOgImage /> : <BannerOgImage />}
    </div>
  );
}
