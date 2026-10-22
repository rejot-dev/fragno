import homePageSource from "@backoffice-static/skills/building-pages/examples/home.page.js?raw";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { backofficePageColumnClassName } from "@fragno-private/design-system/tab-header";
import { useMemo } from "react";

import type { BackofficeUiLinkTarget } from "../../components/link";
import { PageView } from "../view";
import {
  BUSY_SCOPE,
  EMPTY_SCOPE,
  STORY_COLLECTION_FIELDS,
  STORY_NOW,
  storySources,
  type StoryScope,
} from "./backoffice-scope.fixture";
import { buildPageSource } from "./build-page-source";

export default { title: "Pages/Home page" };

/** Stories have no scope to open, so links lead to a description of their target. */
function storyLink(target: BackofficeUiLinkTarget): string {
  return `#${Object.values(target).join("/")}`;
}

/** The home page as its route shows it, built from the source Backoffice ships. */
function HomePage({ scope }: { scope: StoryScope }) {
  const built = useMemo(() => buildPageSource(homePageSource, STORY_COLLECTION_FIELDS), []);
  const sources = useMemo(() => storySources(scope), [scope]);
  return (
    <div className={`${backofficePageColumnClassName} flex flex-col gap-4`}>
      <h1 className="text-lg font-semibold text-[var(--bo-fg)]">home</h1>
      {built.kind === "invalid" ? (
        <BackofficeSystemState
          tone="error"
          label="Invalid page"
          title="This page could not be built."
          description={built.message}
        />
      ) : (
        <PageView
          definition={built.definition}
          sources={sources}
          now={STORY_NOW}
          links={storyLink}
        />
      )}
    </div>
  );
}

export function Busy() {
  return <HomePage scope={BUSY_SCOPE} />;
}

export function Empty() {
  return <HomePage scope={EMPTY_SCOPE} />;
}
