import { FragnoLogo } from "@/components/logos/fragno-logo";
import { React as ReactLogo } from "@/components/logos/frameworks/react";
import { Nextjs } from "@/components/logos/frameworks/nextjs";
import { Vue } from "@/components/logos/frameworks/vue";
import { Svelte } from "@/components/logos/frameworks/svelte";
import { Astro } from "@/components/logos/frameworks/astro";
import { Nuxt } from "@/components/logos/frameworks/nuxt";
import { Nodejs } from "@/components/logos/frameworks/nodejs";

export function BannerOgImage() {
  return (
    <div className="relative flex h-[630px] w-[1200px] flex-col items-center justify-center overflow-hidden bg-white dark:bg-slate-900">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/15 via-sky-400/10 to-purple-500/15 dark:from-blue-500/25 dark:via-sky-400/15 dark:to-purple-500/25" />

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center justify-center space-y-6 px-20 text-center">
        {/* Logo */}
        <div className="mb-4 flex justify-center">
          <FragnoLogo className="h-64 w-80 dark:text-white" />
        </div>

        {/* Title */}
        <h1 className="text-8xl font-extrabold leading-tight tracking-tight text-gray-900 dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
          Build Full-
          <span className="relative inline-block text-gray-900 dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
            Stack
            <span className="absolute -right-12 -top-2 inline-flex rotate-12 items-center">
              <span className="relative inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-slate-600 via-gray-600 to-zinc-600 px-5 py-2 text-white shadow-[0_12px_30px_-12px_rgba(99,102,241,0.65)] ring-1 ring-white/20">
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-0.5 -z-10 rounded-full bg-gradient-to-r from-indigo-500/30 to-fuchsia-500/30 blur-md"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/10"
                />
                <span className="text-sm font-semibold tracking-wider">Developer Beta</span>
              </span>
            </span>
          </span>
          <br />
          Libraries
        </h1>

        {/* Framework logos */}
        <div className="mt-8 flex flex-col items-center">
          {/* <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600 dark:text-white/60">
            Works with
          </div> */}
          <div className="flex flex-wrap items-center justify-center gap-4 text-slate-700 dark:text-white/70">
            <ReactLogo className="size-8" />
            <Nextjs className="size-8" />
            <Vue className="size-8" />
            <Svelte className="size-8" />
            <Astro className="size-8" />
            <Nuxt className="size-8" />
            <Nodejs className="size-8" />
          </div>
        </div>
      </div>
    </div>
  );
}
