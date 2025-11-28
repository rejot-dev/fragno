import { ThemeToggle } from "fumadocs-ui/components/layout/theme-toggle";
import { OriginalOgImage } from "../../og-image/original-og-image";
import { BannerOgImage } from "../../og-image/banner-og-image";
import { useState } from "react";
import { Check, Image, Palette } from "lucide-react";

export function loader() {
  // Only allow access in development mode
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }
  return null;
}

export default function OgImagePage() {
  // Use state for image type instead of query params
  const [imageType, setImageType] = useState<"banner" | "original">("banner");

  return (
    <div className="relative">
      {/* Theme Toggle and Image Type Options */}
      <div className="absolute right-4 top-4 z-20 flex flex-col gap-3">
        <ThemeToggle />

        {/* Image Type Options */}
        <div className="bg-background/95 border-border/50 flex flex-col gap-1 rounded-xl border p-3 shadow-xl backdrop-blur-md">
          <div className="text-muted-foreground flex items-center gap-2 px-1 py-1 text-xs font-semibold">
            <Image className="h-3 w-3" />
            Image Type
          </div>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setImageType("banner")}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ${
                imageType === "banner"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "hover:bg-muted/50 text-foreground"
              }`}
            >
              <div className="flex items-center gap-2">
                <Palette className="h-3.5 w-3.5" />
                Banner
              </div>
              {imageType === "banner" && <Check className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={() => setImageType("original")}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ${
                imageType === "original"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "hover:bg-muted/50 text-foreground"
              }`}
            >
              <div className="flex items-center gap-2">
                <Image className="h-3.5 w-3.5" />
                Original
              </div>
              {imageType === "original" && <Check className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* OG Image content */}
      {imageType === "original" ? <OriginalOgImage /> : <BannerOgImage />}
    </div>
  );
}
