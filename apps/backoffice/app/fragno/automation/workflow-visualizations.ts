import {
  visualizeWorkflowSource,
  type WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

// More scripts than a page shows at once; the least recently used parse is dropped first.
const CACHED_VISUALIZATIONS = 64;
const visualizations = new Map<string, WorkflowVisualizationSnapshot>();

/**
 * The visualization of a workflow script, parsed once per path and source in this tab, so the
 * views showing one script, such as the universe, the graph's inspector, and a run's timeline,
 * share its parse. Callers only read it.
 */
export function visualizeWorkflowScript(
  filename: string,
  code: string,
): WorkflowVisualizationSnapshot {
  const key = JSON.stringify([filename, code]);
  const cached = visualizations.get(key);
  if (cached) {
    // Used again, it moves to the end, so the first entry is always the least recently used.
    visualizations.delete(key);
    visualizations.set(key, cached);
    return cached;
  }
  const visualization = visualizeWorkflowSource(filename, code);
  visualizations.set(key, visualization);
  const oldest = visualizations.keys().next();
  if (visualizations.size > CACHED_VISUALIZATIONS && !oldest.done) {
    visualizations.delete(oldest.value);
  }
  return visualization;
}
