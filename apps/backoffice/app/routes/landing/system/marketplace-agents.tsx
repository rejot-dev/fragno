const MARKETPLACE_CONTENT = [
  { label: "Skill", value: "slack/SKILL.md" },
  { label: "Workflows", value: "triage-message.workflow.js" },
  { label: "", value: "publish-digest.workflow.js" },
] as const;

export function MarketplaceAgents() {
  return (
    <section aria-labelledby="marketplace-agents-heading">
      <div className="grid overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] lg:grid-cols-[0.42fr_0.58fr]">
        <div className="border-b border-[color:var(--bo-border)] p-7 sm:p-10 lg:border-r lg:border-b-0 lg:p-12">
          <h2
            id="marketplace-agents-heading"
            className="max-w-md text-[clamp(2.25rem,4.4vw,4.25rem)] leading-[0.96] font-[560] tracking-[-0.055em] text-balance"
          >
            Sharable Workflows.
          </h2>
          <p className="mt-6 max-w-md text-sm leading-7 text-pretty text-[var(--bo-muted)]">
            Use the marketplace to share workflows, skills, and supporting files with colleagues and
            the community. Get up and running quickly with prebuilt automations.
          </p>
        </div>

        <div className="bg-[var(--bo-panel-2)] p-4 sm:p-7 lg:p-9">
          <article className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)]">
            <header className="flex items-center justify-between gap-4 border-b border-[color:var(--bo-border)] px-5 py-4">
              <h3 className="text-base font-semibold text-[var(--bo-fg)]">Slack workflows</h3>
              <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">v1.3.0</span>
            </header>

            <div className="p-5">
              <p className="text-sm leading-6 text-[var(--bo-muted)]">
                Triages channel messages, answers from approved knowledge, and publishes a daily
                workspace digest.
              </p>

              <div className="mt-6 divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)]">
                {MARKETPLACE_CONTENT.map((item) => (
                  <div key={item.value} className="flex items-center gap-3 py-3">
                    <span className="w-20 shrink-0 text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
                      {item.label}
                    </span>
                    <span className="ml-auto min-w-0 truncate text-right font-mono text-[11px] text-[var(--bo-fg)]">
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
