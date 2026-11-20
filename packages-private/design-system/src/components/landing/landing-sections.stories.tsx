import type { ComponentProps, ReactNode } from "react";

import { LandingAbout } from "./about";
import { LandingAgencyClients } from "./agency-clients";
import { LandingAgentsWrite } from "./agents-write";
import { LandingAppsPlatform } from "./apps-platform";
import { LandingAuditTrail } from "./audit-trail";
import { LandingCase, LandingCases } from "./cases";
import { LandingComputers } from "./computers";
import { LandingGenerativeUi } from "./generative-ui";
import { LandingGetStarted } from "./get-started";
import { LandingClosing, LandingHero } from "./hero";
import { LandingHeroPhoto } from "./hero-photo";
import { LandingPageColumn } from "./landing-section";
import { LandingLivePages } from "./live-pages";
import { LandingPartners } from "./partners";
import { LandingTools } from "./tools";
import { LandingWorkspaces } from "./workspaces";

export default { title: "Landing/Sections" };

function Column({ children }: { children: ReactNode }) {
  return <LandingPageColumn>{children}</LandingPageColumn>;
}

export function Hero() {
  return <LandingHero />;
}

export function HeroPhotoSunsetRidges() {
  return <HeroPhotoFrame photo="sunset-ridges" />;
}

export function HeroPhotoStarryPeaks() {
  return <HeroPhotoFrame photo="starry-peaks" />;
}

export function HeroPhotoCloudSea() {
  return <HeroPhotoFrame photo="cloud-sea" />;
}

export function HeroPhotoDolomitesFire() {
  return <HeroPhotoFrame photo="dolomites-fire" />;
}

export function HeroPhotoLayeredDawn() {
  return <HeroPhotoFrame photo="layered-dawn" />;
}

export function HeroPhotoClearValley() {
  return <HeroPhotoFrame photo="clear-valley" />;
}

export function HeroPhotoMatterhorn() {
  return <HeroPhotoFrame photo="matterhorn" />;
}

export function HeroPhotoGoldenSilhouettes() {
  return <HeroPhotoFrame photo="golden-silhouettes" />;
}

export function HeroPhotoFitzRoy() {
  return <HeroPhotoFrame photo="fitz-roy" />;
}

function HeroPhotoFrame({ photo }: { photo: ComponentProps<typeof LandingHeroPhoto>["photo"] }) {
  return (
    <div className="relative h-[640px] overflow-hidden bg-[#232322]">
      <div aria-hidden="true" className="landing-film-mono">
        <LandingHeroPhoto photo={photo} />
      </div>
    </div>
  );
}

export function AgentsWrite() {
  return (
    <Column>
      <LandingAgentsWrite />
    </Column>
  );
}

export function Cases() {
  return (
    <div className="py-16 lg:py-24">
      <LandingCases />
    </div>
  );
}

export function Case() {
  return (
    <Column>
      <LandingCase slug="online-shop" />
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

export function Partners() {
  return (
    <Column>
      <LandingPartners />
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

export function About() {
  return (
    <Column>
      <LandingAbout />
    </Column>
  );
}

export function GetStarted() {
  return <LandingGetStarted />;
}
