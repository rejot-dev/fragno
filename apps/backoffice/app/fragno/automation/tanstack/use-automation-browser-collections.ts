import { useEffect, useState } from "react";

import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";

import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserCollections,
} from "./browser-database";

type AutomationBrowserCollectionsState = {
  /** Null until the scope's browser database opens, and when it cannot. */
  collections: AutomationBrowserCollections | null;
  error: string | null;
};

/**
 * The current scope's synchronized collections, for views that render before they are ready
 * instead of suspending, such as pages rendered on the server.
 */
export function useAutomationBrowserCollections(): AutomationBrowserCollectionsState {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  const source =
    automationCollectionSource.status === "ready" ? automationCollectionSource.source : null;
  const sourceKey = source ? describeAutomationCollectionSource(source).resourceKey : null;
  const [state, setState] = useState<AutomationBrowserCollectionsState>({
    collections: null,
    error:
      automationCollectionSource.status === "unavailable"
        ? automationCollectionSource.message
        : null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!source) {
      setState({
        collections: null,
        error:
          automationCollectionSource.status === "unavailable"
            ? automationCollectionSource.message
            : null,
      });
      return () => {
        cancelled = true;
      };
    }
    setState({ collections: null, error: null });
    void getAutomationBrowserDatabase(source).then(
      ({ collections }) => {
        if (!cancelled) {
          setState({ collections, error: null });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            collections: null,
            error: cause instanceof Error ? cause.message : "Automation synchronization failed.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [automationCollectionSource, source, sourceKey]);

  return state;
}
