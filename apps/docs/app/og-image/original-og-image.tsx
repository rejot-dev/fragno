import { FragnoLogo } from "@/components/logos/fragno-logo";

export function OriginalOgImage() {
  return (
    <div className="relative flex h-[630px] w-[1200px] flex-col items-center justify-center overflow-hidden bg-white dark:bg-slate-900">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/15 via-sky-400/10 to-purple-500/15 dark:from-blue-500/25 dark:via-sky-400/15 dark:to-purple-500/25" />

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center justify-center space-y-6 px-20 text-center">
        {/* Logo */}
        <div className="mb-2 flex justify-center">
          <FragnoLogo className="h-48 w-64 dark:text-white" />
        </div>

        {/* Title */}
        <h1 className="text-6xl font-extrabold leading-tight tracking-tight text-gray-900 dark:text-white">
          Build Full-
          <span className="relative inline-block">
            Stack
            <span className="absolute -right-3 -top-2 inline-flex rotate-12 items-center">
              <span className="relative inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-slate-600 via-gray-600 to-zinc-600 px-4 py-1.5 text-white shadow-lg ring-1 ring-white/20">
                <span className="text-xs font-semibold tracking-wider">Developer Beta</span>
              </span>
            </span>
          </span>
          <br />
          Libraries
        </h1>

        {/* Subtitle */}
        <p className="max-w-4xl text-2xl leading-relaxed text-gray-600 dark:text-gray-300">
          Build{" "}
          <span className="underline decoration-blue-600 underline-offset-4 dark:decoration-blue-400">
            fr
          </span>
          amework-
          <span className="underline decoration-purple-600 underline-offset-4 dark:decoration-purple-400">
            agno
          </span>
          stic libraries that embed backend and frontend logic in your users' applications
        </p>
      </div>
    </div>
  );
}
