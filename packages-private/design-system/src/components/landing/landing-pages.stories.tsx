import { LandingAppsPlatform } from "./apps-platform";
import { LandingComputers } from "./computers";
import { LandingGenerativeUi } from "./generative-ui";
import { LandingHero } from "./hero";
import { LandingHomeSections } from "./home";
import { LandingPageColumn } from "./landing-section";
import { LandingTools } from "./tools";

export default { title: "Landing/Pages" };

/** The homepage as Backoffice renders it, between its header and footer. */
export function Home() {
  return (
    <>
      <LandingHero />
      <LandingHomeSections />
    </>
  );
}

/** For developers: building on the platform and the heavier tools it offers. */
export function Developers() {
  return (
    <LandingPageColumn>
      <header className="border-b border-[color:var(--bo-border)] pb-16">
        <h1 className="max-w-4xl text-[clamp(3rem,7vw,6.5rem)] leading-[0.9] font-[560] tracking-[-0.07em] text-balance">
          Build on Backoffice
        </h1>
        <p className="mt-8 max-w-2xl text-base leading-7 text-pretty text-[var(--bo-muted)]">
          Sign people in with Backoffice, give agents your app&rsquo;s actions, and run real code
          when a workflow is not enough.
        </p>
      </header>
      <LandingAppsPlatform />
      <LandingTools />
      <LandingComputers />
      <LandingGenerativeUi />
    </LandingPageColumn>
  );
}
