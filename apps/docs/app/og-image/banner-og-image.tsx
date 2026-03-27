const mono =
  'font-mono [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation_Mono",monospace]';

export function BannerOgImage() {
  return (
    <div className="relative flex h-[630px] w-[1200px] flex-col overflow-hidden bg-(--editorial-paper)">
      {/* Page road */}
      <div
        className="absolute top-0 bottom-0 left-0 w-[3px]"
        style={{
          backgroundImage: `linear-gradient(to bottom, var(--editorial-primary) 15%, var(--editorial-tertiary) 45%, var(--editorial-secondary) 75%, var(--editorial-primary) 100%)`,
        }}
      />

      <div className="flex flex-1 flex-col justify-between py-[44px] pr-[72px] pl-[32px]">
        {/* Header */}
        <div className={`${mono} flex items-center gap-[10px]`}>
          <span className="inline-block h-2 w-2 rounded-full bg-(--editorial-primary)" />
          <span className="text-[15px] font-semibold tracking-[0.04em] text-(--editorial-ink)">
            Fragno
          </span>
        </div>

        {/* Title area */}
        <div className="flex flex-col gap-5 pl-3">
          <div
            className={`${mono} text-[14px] font-semibold tracking-[0.14em] text-(--editorial-primary) uppercase`}
          >
            Full-stack library toolkit
          </div>
          <h1 className="text-[72px] leading-[0.96] font-bold tracking-[-0.045em] text-(--editorial-ink)">
            Build Full-Stack Libraries
          </h1>
          <p
            className={`${mono} max-w-[680px] text-[16px] leading-[1.7] font-normal tracking-[0.02em] text-(--editorial-muted)`}
          >
            Type-safe TypeScript libraries that embed backend, frontend, and data layer in your
            users' applications — across frameworks.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-(--editorial-ghost-border) pt-[22px]">
          <span
            className={`${mono} text-[14px] font-semibold tracking-[0.08em] text-(--editorial-muted)`}
          >
            fragno.dev
          </span>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-(--editorial-primary)" />
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-(--editorial-tertiary)" />
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-(--editorial-secondary)" />
          </div>
        </div>
      </div>
    </div>
  );
}
