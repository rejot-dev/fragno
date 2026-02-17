import { FragnoLogo } from "@/components/logos/fragno-logo";
import { React as ReactLogo } from "@/components/logos/frameworks/react";
import { Nextjs } from "@/components/logos/frameworks/nextjs";
import { Vue } from "@/components/logos/frameworks/vue";
import { Svelte } from "@/components/logos/frameworks/svelte";
import { Astro } from "@/components/logos/frameworks/astro";
import { Nuxt } from "@/components/logos/frameworks/nuxt";
import { Nodejs } from "@/components/logos/frameworks/nodejs";
import { OgSlideFrame } from "./slide-frame";

export function BannerOgImage() {
  return (
    <OgSlideFrame>
      <div className="relative z-10 flex h-full w-full items-center px-20 py-16">
        <div className="grid w-full grid-cols-[1.35fr_0.65fr] items-center gap-10">
          <div className="space-y-7">
            <h1 className="max-w-3xl text-7xl font-extrabold leading-[1.05] tracking-tight text-slate-900 dark:text-white">
              Integrate full-stack
              <br />
              libraries in minutes
            </h1>

            <p className="max-w-3xl text-3xl leading-tight text-slate-600 dark:text-slate-300">
              Drop in auth, billing, forms, or workflows without stitching backend routes, database
              tables, and frontend hooks by hand.
            </p>
          </div>

          <div className="flex justify-center">
            <FragnoLogo className="size-80 text-slate-900 dark:text-white" />
          </div>
        </div>
      </div>

      <div className="absolute bottom-8 left-20 z-20">
        <div className="flex items-center gap-4 text-slate-600 dark:text-slate-300">
          <ReactLogo className="size-8" />
          <Nextjs className="size-8" />
          <Vue className="size-8" />
          <Svelte className="size-8" />
          <Astro className="size-8" />
          <Nuxt className="size-8" />
          <Nodejs className="size-8" />
        </div>
      </div>
    </OgSlideFrame>
  );
}
