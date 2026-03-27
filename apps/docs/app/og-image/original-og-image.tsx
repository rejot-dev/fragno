const mono =
  'font-mono [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation_Mono",monospace]';

export function OriginalOgImage() {
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
        <div className="flex items-center justify-between">
          <div className={`${mono} flex items-center gap-[10px]`}>
            <span className="inline-block h-2 w-2 rounded-full bg-(--editorial-primary)" />
            <span className="text-[15px] font-semibold tracking-[0.04em] text-(--editorial-ink)">
              Fragno
            </span>
          </div>
          <span
            className={`${mono} text-[13px] font-semibold tracking-[0.14em] text-(--editorial-muted) uppercase`}
          >
            Blog
          </span>
        </div>

        {/* Title */}
        <h1 className="max-w-[980px] pl-3 text-[56px] leading-[1.08] font-bold tracking-[-0.035em] text-(--editorial-ink)">
          Versionstamps: The Perfect Cursor for Pagination
        </h1>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-(--editorial-ghost-border) pt-[22px]">
          <div
            className={`${mono} flex items-center gap-4 text-[14px] tracking-[0.08em] uppercase`}
          >
            <span className="font-semibold text-(--editorial-ink)">Wilco Kruijer</span>
            <span className="text-(--editorial-muted)">·</span>
            <span className="font-normal text-(--editorial-muted)">March 27, 2026</span>
          </div>
          <div className="flex items-center gap-5">
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
    </div>
  );
}
