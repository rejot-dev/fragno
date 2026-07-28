export type InstalledSourceSnapshot = {
  status: "loading" | "ready" | "error";
  recordCount: number;
};

export type InstalledSourceSnapshots = {
  sourceSetKey: string;
  byOrganizationId: Readonly<Record<string, InstalledSourceSnapshot>>;
};

export const summarizeInstalledWorkspace = (input: {
  sourceOrganizationIds: readonly string[];
  snapshots: Readonly<Record<string, InstalledSourceSnapshot>>;
}) => {
  const reportedSnapshots = input.sourceOrganizationIds.flatMap((organizationId) => {
    const snapshot = input.snapshots[organizationId];
    return snapshot ? [snapshot] : [];
  });
  const allSourcesReported = reportedSnapshots.length === input.sourceOrganizationIds.length;
  const totalRecordCount = reportedSnapshots.reduce(
    (total, snapshot) => total + snapshot.recordCount,
    0,
  );
  const hasSourceError = reportedSnapshots.some((snapshot) => snapshot.status === "error");
  const isLoading =
    !allSourcesReported || reportedSnapshots.some((snapshot) => snapshot.status === "loading");

  return {
    isLoading,
    showEmpty: allSourcesReported && !hasSourceError && totalRecordCount === 0,
    totalRecordCount,
  };
};
