"use client";

import { cn } from "@/lib/cn";
import { Astro } from "@/components/logos/frameworks/astro";
import { Nextjs } from "@/components/logos/frameworks/nextjs";
import { Nodejs } from "@/components/logos/frameworks/nodejs";
import { Nuxt } from "@/components/logos/frameworks/nuxt";
import { React as ReactLogo } from "@/components/logos/frameworks/react";
import { Svelte } from "@/components/logos/frameworks/svelte";
import { Vue } from "@/components/logos/frameworks/vue";
import { Solid } from "@/components/logos/frameworks/solid";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

export default function Frameworks({ className }: { className?: string }) {
  const [mouseX, setMouseX] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (window.innerWidth < 1024) {
      return;
    }
    setHydrated(true);

    const handlePointerMove = (e: PointerEvent) => {
      setMouseX(e.clientX);
    };

    const handleResize = () => {
      setViewportWidth(window.innerWidth || 1);
    };

    // Initialize
    handleResize();
    setMouseX(window.innerWidth / 2);

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const items = useMemo(() => {
    return [
      { name: "React", element: <ReactLogo className="size-12 text-blue-500" /> },
      { name: "Vue", element: <Vue className="size-12 text-green-500" /> },
      { name: "Svelte", element: <Svelte className="size-12 text-red-500" /> },
      { name: "SolidJS", element: <Solid className="size-12 text-blue-500" /> },
      { name: "Astro", element: <Astro className="size-12" /> },
      { name: "Next.js", element: <Nextjs className="size-12 text-gray-900 dark:text-white" /> },
      { name: "Nuxt", element: <Nuxt className="size-12 text-green-400 dark:text-white" /> },
      { name: "Node.js", element: <Nodejs className="size-12 text-green-600" /> },
      {
        name: "Go to Docs",
        element: (
          <a
            href="/docs/fragno/reference/frameworks"
            className="flex size-12 items-center justify-center rounded-md border border-dashed border-gray-300 text-xs font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200"
          >
            More
          </a>
        ),
      },
    ];
  }, []);

  const activeIndex = useMemo(() => {
    if (items.length === 0) {
      return 0;
    }
    let ratio: number;
    const container = gridRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : 1;
      ratio = (mouseX - rect.left) / width;
    } else {
      const width = viewportWidth > 0 ? viewportWidth : 1;
      ratio = mouseX / width;
    }
    ratio = Math.min(1, Math.max(0, ratio));
    // Split into equal-width bins across the container
    let index = Math.floor(ratio * items.length);
    if (index >= items.length) {
      index = items.length - 1;
    }
    return index;
  }, [mouseX, viewportWidth, items.length]);

  const getIntensityForIndex = (index: number): number => {
    if (!hydrated) {
      // SSR, no-JS fallback, or mobile: everything stays grayscale
      return 0;
    }
    const distance = Math.abs(index - activeIndex);
    if (distance === 0) {
      return 1;
    }
    if (distance === 1) {
      return 0.5;
    }
    return 0;
  };

  const getStyleForIntensity = (intensity: number): CSSProperties => {
    const grayscale = 1 - intensity; // 1: fully gray, 0: full color
    const saturate = 1 + 0.6 * intensity;
    const brightness = 1 + 0.12 * intensity;
    const scale = 1 + 0.08 * intensity;
    const translateY = -2 * intensity; // subtle lift when active
    return {
      filter: `grayscale(${grayscale}) saturate(${saturate}) brightness(${brightness})`,
      transform: `translateY(${translateY}px) scale(${scale})`,
      transition: "filter 250ms ease, transform 300ms ease, opacity 250ms ease",
      opacity: 0.7 + 0.3 * intensity,
      willChange: "transform, filter, opacity",
    };
  };

  return (
    <section className={cn("w-full max-w-6xl space-y-6", className)}>
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Frameworks</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          These frameworks{" "}
          <a href="/docs/fragno/reference/frameworks" className="text-blue-500 hover:underline">
            and more
          </a>{" "}
          are already supported
        </p>
      </div>
      <div
        ref={gridRef}
        className="mx-auto grid w-full max-w-4xl grid-cols-2 gap-6 p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-9"
      >
        {items.map((item, index) => {
          const intensity = getIntensityForIndex(index);
          const style = getStyleForIntensity(intensity);
          return (
            <div key={item.name} className="flex flex-col items-center gap-2">
              <div className="rounded-md p-1" style={style} aria-label={`${item.name} logo`}>
                {item.element}
              </div>
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                {item.name}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
