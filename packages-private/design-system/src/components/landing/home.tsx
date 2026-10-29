import type { ReactNode } from "react";

import { LandingAgentsWrite } from "./agents-write";
import { LandingAuditTrail } from "./audit-trail";
import { LandingClosing } from "./hero";
import { LandingTools } from "./tools";

/**
 * The homepage after its hero, in reading order: how an agent sets up each team's process, proof
 * of what ran, the tools it works with, and the point of view it closes on.
 */
export function LandingHomeSections() {
  return (
    <>
      <div className="pb-24 sm:pb-32">
        <Column>
          <LandingAgentsWrite />
        </Column>
      </div>
      {/* The trace is the page's proof, so it breaks the rhythm: full width and dark, whatever
          theme the page is in. A nested root takes on the dark palette. */}
      <div className="dark">
        <div data-backoffice-root className="bg-[var(--bo-bg)] py-20 text-[var(--bo-fg)] sm:py-28">
          <Column>
            <LandingAuditTrail />
          </Column>
        </div>
      </div>
      <div className="pt-24 sm:pt-32">
        <Column>
          <LandingTools />
        </Column>
      </div>
      <div className="pt-28 pb-24 sm:pt-36 sm:pb-32">
        <Column>
          <LandingClosing />
        </Column>
      </div>
    </>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1180px] px-5 sm:px-8 lg:px-12">{children}</div>;
}
