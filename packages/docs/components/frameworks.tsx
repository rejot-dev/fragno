import { cn } from "@/lib/cn";
import { Astro } from "@/components/logos/frameworks/astro";
import { Nextjs } from "@/components/logos/frameworks/nextjs";
import { Nodejs } from "@/components/logos/frameworks/nodejs";
import { Nuxt } from "@/components/logos/frameworks/nuxt";
import { React as ReactLogo } from "@/components/logos/frameworks/react";
import { Svelte } from "@/components/logos/frameworks/svelte";
import { Vue } from "@/components/logos/frameworks/vue";

export default function Frameworks({ className }: { className?: string }) {
  return (
    <section className={cn("w-full max-w-6xl space-y-6", className)}>
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Frameworks</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          The majority of popular frameworks are already supported by Fragno. See{" "}
          <a href="/docs/frameworks" className="text-blue-500 hover:underline">
            our docs
          </a>{" "}
          for more info.
        </p>
      </div>
      <div className="mx-auto grid w-full max-w-4xl grid-cols-2 gap-6 p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
        <div className="flex flex-col items-center gap-2">
          <ReactLogo className="size-12 text-blue-500" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">React</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Vue className="size-12 text-green-500" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Vue</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Svelte className="size-12 text-red-500" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Svelte</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Astro className="size-12" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Astro</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Nextjs className="size-12 text-gray-900 dark:text-white" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Next.js</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Nuxt className="size-12 text-green-400 dark:text-white" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Nuxt</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Nodejs className="size-12 text-green-600" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Node.js</span>
        </div>
      </div>
    </section>
  );
}
