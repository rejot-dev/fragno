import { ThemeToggle } from "fumadocs-ui/components/layout/theme-toggle";
import { OriginalOgImage } from "../../og-image/original-og-image";
import { BannerOgImage } from "../../og-image/banner-og-image";
import { useState, type ReactNode } from "react";
import { Check, Image, Palette } from "lucide-react";
import { ProductHuntSlideLibraries } from "@/og-image/product-hunt-slide-libraries";
import { ProductHuntSlideFragments } from "@/og-image/product-hunt-slide-fragments";
import { ProductHuntSlideSkill } from "@/og-image/product-hunt-slide-skill";
import { ProductHuntSlideAuth } from "@/og-image/product-hunt-slide-auth";
import { ProductHuntSlideBilling } from "@/og-image/product-hunt-slide-billing";
import { ProductHuntSlideWorkflows } from "@/og-image/product-hunt-slide-workflows";
import { ProductHuntSlideUpload } from "@/og-image/product-hunt-slide-upload";
import { ProductHuntSlideForms } from "@/og-image/product-hunt-slide-forms";

type SlideId =
  | "overview"
  | "libraries"
  | "fragments"
  | "skill"
  | "auth"
  | "billing"
  | "workflows"
  | "upload"
  | "forms"
  | "original";

const slides: { id: SlideId; label: string; icon: ReactNode }[] = [
  { id: "original", label: "Original", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "overview", label: "Overview", icon: <Palette className="h-3.5 w-3.5" /> },
  { id: "libraries", label: "Slide 1", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "fragments", label: "Slide 2", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "skill", label: "Slide 3", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "auth", label: "Auth", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "billing", label: "Billing", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "workflows", label: "Workflows", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "upload", label: "Upload", icon: <Image className="h-3.5 w-3.5" /> },
  { id: "forms", label: "Forms", icon: <Image className="h-3.5 w-3.5" /> },
];

export function loader() {
  // Only allow access in development mode
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }
  return null;
}

export default function OgImagePage() {
  const [slideId, setSlideId] = useState<SlideId>("overview");

  return (
    <div className="relative">
      {/* Theme Toggle and Image Type Options */}
      <div className="absolute right-4 top-4 z-20 flex flex-col gap-3">
        <ThemeToggle />

        {/* Image Type Options */}
        <div className="bg-background/95 border-border/50 flex flex-col gap-1 rounded-xl border p-3 shadow-xl backdrop-blur-md">
          <div className="flex flex-col gap-1">
            {slides.map((slide) => (
              <button
                key={slide.id}
                onClick={() => setSlideId(slide.id)}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ${
                  slideId === slide.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "hover:bg-muted/50 text-foreground"
                }`}
              >
                <div className="flex items-center gap-2">
                  {slide.icon}
                  {slide.label}
                </div>
                {slideId === slide.id && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {slideId === "overview" && <BannerOgImage />}
      {slideId === "libraries" && <ProductHuntSlideLibraries />}
      {slideId === "fragments" && <ProductHuntSlideFragments />}
      {slideId === "skill" && <ProductHuntSlideSkill />}
      {slideId === "auth" && <ProductHuntSlideAuth />}
      {slideId === "billing" && <ProductHuntSlideBilling />}
      {slideId === "workflows" && <ProductHuntSlideWorkflows />}
      {slideId === "upload" && <ProductHuntSlideUpload />}
      {slideId === "forms" && <ProductHuntSlideForms />}
      {slideId === "original" && <OriginalOgImage />}
    </div>
  );
}
