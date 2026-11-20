import { LandingSection } from "./landing-section";

type Belief = { title: string; body: string };

// Placeholder copy for the About page, drawn from what the product already says about itself;
// replace it with the team's own words.
const BELIEFS: readonly Belief[] = [
  {
    title: "Describe it, don't build it",
    body: "People know how their business runs. They should be able to say it in their own words and have it run, without learning a workflow tool first.",
  },
  {
    title: "The same way every time",
    body: "AI writes the workflow; the workflow does the work. What runs is code you can read, so it behaves the same on the hundredth run as on the first.",
  },
  {
    title: "Ask before acting, record every step",
    body: "Automations stop for a person when it matters and keep a trail of everything they did, so you can trust them with real work.",
  },
];

/** The About page: what Leyway is for, what it believes, and who backs it. */
export function LandingAbout() {
  return (
    <div className="space-y-24">
      <header>
        <p className="text-sm font-semibold text-[var(--bo-muted)]">About us</p>
        <h1 className="font-heading mt-4 max-w-4xl text-[clamp(2.5rem,5.5vw,4.75rem)] leading-[1] font-light tracking-[-0.06em] text-balance">
          We build automation that businesses can trust.
        </h1>
        <p className="mt-8 max-w-2xl text-lg leading-8 text-pretty text-[var(--bo-muted)]">
          Leyway turns how a business runs into workflows. You describe the process, agents write
          it, and it runs the same way every time: deterministic, auditable, and in your control.
        </p>
      </header>
      <LandingSection
        id="landing-about-beliefs"
        title="What we believe."
        visual={
          <ul className="grid gap-4 md:grid-cols-3">
            {BELIEFS.map((belief) => (
              <li
                key={belief.title}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-6"
              >
                <h3 className="text-base font-semibold">{belief.title}</h3>
                <p className="mt-3 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                  {belief.body}
                </p>
              </li>
            ))}
          </ul>
        }
      >
        Three ideas shape everything we make.
      </LandingSection>
      <LandingSection id="landing-about-backing" title="Backed by Y Combinator." visual={null}>
        Leyway is built by a small team and backed by Y Combinator. We build it on Fragno, our open
        source framework for full-stack libraries.
      </LandingSection>
    </div>
  );
}
