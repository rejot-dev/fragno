import type { ReactNode } from "react";

import { LandingAgencyClients } from "./agency-clients";
import { LandingAgentsWrite } from "./agents-write";
import { LandingAppsPlatform } from "./apps-platform";
import { LandingAuditTrail } from "./audit-trail";
import { LandingComputers } from "./computers";
import { LandingGenerativeUi } from "./generative-ui";
import { LandingClosing, LandingHero } from "./hero";
import { LandingPageColumn } from "./landing-section";
import { LandingLivePages } from "./live-pages";
import { LandingTools } from "./tools";
import { LandingWorkspaces } from "./workspaces";

export default { title: "Landing/Sections" };

function Column({ children }: { children: ReactNode }) {
  return <LandingPageColumn>{children}</LandingPageColumn>;
}

export function Hero() {
  return <LandingHero />;
}

export function AgentsWrite() {
  return (
    <Column>
      <LandingAgentsWrite />
    </Column>
  );
}

export function AuditTrail() {
  return (
    <Column>
      <LandingAuditTrail />
    </Column>
  );
}

export function LivePages() {
  return (
    <Column>
      <LandingLivePages />
    </Column>
  );
}

export function Workspaces() {
  return (
    <Column>
      <LandingWorkspaces />
    </Column>
  );
}

export function Tools() {
  return (
    <Column>
      <LandingTools />
    </Column>
  );
}

export function Closing() {
  return (
    <Column>
      <LandingClosing />
    </Column>
  );
}

export function AgencyClients() {
  return (
    <Column>
      <LandingAgencyClients />
    </Column>
  );
}

export function Computers() {
  return (
    <Column>
      <LandingComputers />
    </Column>
  );
}

export function AppsPlatform() {
  return (
    <Column>
      <LandingAppsPlatform />
    </Column>
  );
}

export function GenerativeUi() {
  return (
    <Column>
      <LandingGenerativeUi />
    </Column>
  );
}
