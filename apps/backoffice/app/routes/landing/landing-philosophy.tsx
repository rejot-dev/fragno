export function LandingPhilosophy() {
  return (
    <section className="mx-auto w-full max-w-[1180px] px-5 py-28 sm:px-8 lg:px-12 lg:py-36">
      <div className="border-y border-[color:var(--bo-border)] py-16 sm:py-20">
        <h2 className="max-w-4xl text-[clamp(2.75rem,6vw,6rem)] leading-[0.92] font-[560] tracking-[-0.065em] text-balance">
          AI is a tool,
          <br />
          <span className="text-[var(--bo-muted-2)]">not a co-worker.</span>
        </h2>
        <p className="mt-8 max-w-2xl text-sm leading-7 text-pretty text-[var(--bo-muted)]">
          Backoffice uses models to translate intent, generate interfaces, and write workflows. It
          does not pretend software is a person. Execution remains deterministic, inspectable, and
          governed by your systems.
        </p>
      </div>
    </section>
  );
}
