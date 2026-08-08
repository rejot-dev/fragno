const capabilities = [
  { label: "AUTOMATIONS", detail: "Triggers, schedules, and durable workflows.", tone: "accent" },
  { label: "EVENTS", detail: "A clear record of what happened.", tone: "live" },
  { label: "FILES", detail: "Mounted workspaces with explicit ownership.", tone: "muted" },
  { label: "INTERFACES", detail: "APIs, integrations, and tool providers.", tone: "waiting" },
  { label: "SANDBOXES", detail: "Isolated execution when work needs space.", tone: "accent" },
  { label: "MARKETPLACE", detail: "Reusable work, ready to install.", tone: "live" },
] as const;

const toneClassNames = {
  accent: "bg-[var(--bo-accent)]",
  live: "bg-[var(--bo-live)]",
  muted: "bg-[var(--bo-muted-2)]",
  waiting: "bg-[var(--bo-waiting)]",
};

export function CapabilityGrid() {
  return (
    <section className="border-t border-[color:var(--bo-border)] bg-[color-mix(in_srgb,var(--bo-bg)_78%,transparent)] px-[clamp(1.25rem,7vw,7.5rem)] py-[clamp(4rem,8vw,8rem)]">
      <div className="mx-auto max-w-[1380px]">
        <div className="mb-12 grid grid-cols-[0.8fr_1.2fr] items-end gap-8 max-[760px]:grid-cols-1">
          <div>
            <span className="bo-product-code">WORKSPACE / MAP</span>
            <h2 className="mt-5 max-w-xl text-[clamp(2.6rem,5vw,5.5rem)] leading-[0.94] font-[520] tracking-[-0.065em] text-balance">
              Every moving part,
              <br />
              <span className="text-[var(--bo-muted-2)]">one clear view.</span>
            </h2>
          </div>
          <p className="max-w-md justify-self-end border-l border-[color:var(--bo-border-strong)] pl-5 text-sm leading-6 text-pretty text-[var(--bo-muted)] max-[760px]:justify-self-start">
            Follow work from the first event to the final result without losing the thread.
          </p>
        </div>

        <div className="grid grid-cols-3 border-t border-l border-[color:var(--bo-border)] max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
          {capabilities.map((capability, index) => (
            <article
              key={capability.label}
              className="relative min-h-[210px] overflow-hidden border-r border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-6 max-[560px]:min-h-[165px]"
            >
              <div className="flex items-center justify-between font-mono text-[9px] font-bold tracking-[0.18em] text-[var(--bo-muted-2)]">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <i className={`size-[6px] ${toneClassNames[capability.tone]}`} />
              </div>
              <div className="absolute top-[78px] right-0 left-6 h-px bg-[var(--bo-border)]" />
              <div className="absolute top-[70px] right-6 size-4 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)]" />
              <h3 className="mt-20 text-sm font-bold tracking-[0.12em] max-[560px]:mt-16">
                {capability.label}
              </h3>
              <p className="mt-3 max-w-[16rem] text-sm leading-5 text-pretty text-[var(--bo-muted)]">
                {capability.detail}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
