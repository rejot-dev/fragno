// Existing organizations may still have starter routes pointing at this path. Keep the workflow
// loadable until those persisted routes have been removed.
defineWorkflow({ name: "project-files-configure" }, async () => {
  return {
    skipped: true,
    reason: "project-workspaces-use-fixed-database-storage",
  };
});
