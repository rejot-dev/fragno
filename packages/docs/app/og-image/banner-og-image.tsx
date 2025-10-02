import { FragnoLogo } from "@/components/logos/fragno-logo";

export function BannerOgImage() {
  return (
    <div className="relative flex h-[630px] w-[1200px] flex-col items-center justify-center overflow-hidden bg-white dark:bg-slate-900">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/15 via-sky-400/10 to-purple-500/15 dark:from-blue-500/25 dark:via-sky-400/15 dark:to-purple-500/25" />

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center justify-center space-y-8 px-20 text-center">
        {/* Logo */}
        <div className="mb-4 flex justify-center">
          <FragnoLogo className="h-64 w-80 dark:text-white" />
        </div>

        {/* Title */}
        <h1 className="text-8xl font-extrabold leading-tight tracking-tight text-gray-900 dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
          Build Full-
          <span className="relative inline-block text-gray-900 dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
            Stack
            <span className="absolute -right-4 -top-3 inline-flex rotate-12 items-center">
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
      </div>
    </div>
  );
}
