function ProductMark() {
  return (
    <span className="bo-fragment-mark scale-135" data-size="md" data-palette="blue">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

const nodeClassName =
  "absolute z-3 flex items-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] font-mono text-[9px] font-bold tracking-[0.16em] text-[var(--bo-muted)] shadow-[var(--bo-panel-shadow)]";

export function ProductVisual() {
  return (
    <div
      className="relative -ml-[5vw] min-h-[min(58vw,620px)] max-[900px]:-mx-8 max-[900px]:-mt-8 max-[900px]:min-h-[440px] max-[900px]:opacity-90 max-[560px]:-mx-5 max-[560px]:mt-4 max-[560px]:min-h-[360px]"
      aria-hidden="true"
    >
      <div className="absolute inset-[8%_0_4%_8%] border border-[color:var(--bo-border)] [clip-path:polygon(0_0,74%_0,74%_13%,100%_13%,100%_100%,19%_100%,19%_87%,0_87%)]" />
      <div className="absolute top-1/2 right-0 left-[8%] h-px bg-[var(--bo-border-strong)] opacity-55" />
      <div className="absolute top-[8%] bottom-[4%] left-[54%] w-px bg-[var(--bo-border-strong)] opacity-55" />

      <div
        className={`${nodeClassName} bottom-[19%] left-[7%] px-[13px] py-[11px] max-[560px]:left-[3%]`}
      >
        <span className="pr-2 text-[var(--bo-accent)]">01</span>
        <span>EVENT</span>
      </div>
      <div
        className={`${nodeClassName} top-[14%] right-[1%] px-[13px] py-[11px] max-[560px]:right-[3%]`}
      >
        <span className="pr-2 text-[var(--bo-accent)]">02</span>
        <span>RESULT</span>
      </div>
      <div
        className={`${nodeClassName} top-1/2 left-[54%] aspect-square w-[clamp(142px,15vw,190px)] -translate-1/2 flex-col justify-center border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] max-[900px]:w-[150px] max-[560px]:w-[122px]`}
      >
        <div className="mb-[18px]">
          <ProductMark />
        </div>
        <span className="text-[13px] tracking-[0.22em] text-[var(--bo-fg)]">BACKOFFICE</span>
        <span className="mt-[7px] text-[8px] text-[var(--bo-muted-2)]">WORKSPACE</span>
      </div>

      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        viewBox="0 0 800 520"
        preserveAspectRatio="none"
      >
        <path
          d="M70 385 H238 V258 H398"
          className="fill-none stroke-[var(--bo-accent)] stroke-[1.5] [stroke-dasharray:5_7]"
        />
        <path
          d="M510 258 H644 V126 H750"
          className="fill-none stroke-[var(--bo-accent)] stroke-[1.5] [stroke-dasharray:5_7]"
        />
        <circle
          cx="238"
          cy="258"
          r="4"
          className="fill-[var(--bo-bg)] stroke-[var(--bo-accent)] stroke-2"
        />
        <circle
          cx="644"
          cy="126"
          r="4"
          className="fill-[var(--bo-bg)] stroke-[var(--bo-accent)] stroke-2"
        />
      </svg>

      <div className="absolute bottom-[31%] left-[29%] z-2 size-[7px] animate-pulse bg-[var(--bo-live)] shadow-[0_0_0_5px_color-mix(in_srgb,var(--bo-live)_16%,transparent)] motion-reduce:animate-none" />
      <div className="absolute top-[26%] right-[18%] z-2 size-[7px] animate-pulse bg-[var(--bo-live)] shadow-[0_0_0_5px_color-mix(in_srgb,var(--bo-live)_16%,transparent)] [animation-delay:1.2s] motion-reduce:animate-none" />
      <span className="absolute top-[5%] left-[8%] font-mono text-[8px] tracking-[0.18em] text-[var(--bo-muted-2)]">
        SCOPE / 01
      </span>
      <span className="absolute right-0 bottom-0 font-mono text-[8px] tracking-[0.18em] text-[var(--bo-live)]">
        ALL READY
      </span>
    </div>
  );
}
