import { Callout } from "@fragno-private/design-system/callout";
import { ORGANIZATION_GRAPH } from "@fragno-private/design-system/orchestration-graph-story-support";
import { OrchestrationLayeredGraph } from "@fragno-private/design-system/orchestration-layered-graph";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { backofficePageColumnClassName } from "@fragno-private/design-system/tab-header";
import { useEffect, useMemo, useState } from "react";

import type { BackofficeUiLinkTarget } from "../../components/link";
import type { BackofficeUiHostWidgets } from "../../render-context";
import type { PageDefinition } from "../definition";
import { PageView, type PageQueryState } from "../view";
import { buildPageSource } from "./build-page-source";
import { STORY_NOW, storyResults, type StoryScope } from "./story-scope";

/** Stories have no scope to open, so links lead to a description of their target. */
function storyLink(target: BackofficeUiLinkTarget): string {
  return `#${Object.values(target).join("/")}`;
}

/**
 * Backoffice draws these from data a story does not have, so the graph is the design system's
 * sample organization, and the response form a stand-in.
 */
const storyWidgets: BackofficeUiHostWidgets = {
  orchestration: () => (
    <div className="pt-3">
      <OrchestrationLayeredGraph
        graph={ORGANIZATION_GRAPH}
        selected={null}
        onSelect={() => {}}
        pulses={[]}
      />
    </div>
  ),
  workflowResponse: ({ workflowName, instanceId }) => (
    <Callout tone="info" title="Response form">
      Backoffice shows the form {workflowName} run {instanceId} asks you to answer here.
    </Callout>
  ),
};

/** A page as its route shows it, built from its source over the scope's rows. */
export function StoryPage({ source, scope }: { source: string; scope: StoryScope }) {
  const built = useMemo(() => buildPageSource(source), [source]);
  return (
    <div className={`${backofficePageColumnClassName} flex flex-col gap-4`}>
      <h1 className="text-lg font-semibold text-[var(--bo-fg)]">
        {built.kind === "valid" ? built.definition.title : "Invalid page"}
      </h1>
      {built.kind === "invalid" ? (
        <BackofficeSystemState
          tone="error"
          label="Invalid page"
          title="This page could not be built."
          description={built.message}
        />
      ) : (
        <ScopedPageView definition={built.definition} scope={scope} />
      )}
    </div>
  );
}

/** The page over the scope's rows, which its queries read from an in-memory SQLite database. */
function ScopedPageView({ definition, scope }: { definition: PageDefinition; scope: StoryScope }) {
  const [results, setResults] = useState<Record<string, PageQueryState>>({});
  useEffect(() => {
    let cancelled = false;
    void storyResults(scope, definition).then((next) => {
      if (!cancelled) {
        setResults(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [definition, scope]);
  return (
    <PageView
      definition={definition}
      results={results}
      now={STORY_NOW}
      links={storyLink}
      widgets={storyWidgets}
    />
  );
}
