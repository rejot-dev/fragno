/** Mount path of the replayed backend; the page opens its replica with this base URL. */
export const FIXTURE_BASE_PATH = "/fixture";

/** Serves `OutboxFixtureInfo`. */
export const FIXTURE_INFO_PATH = "/fixture-info";

/** What the page needs to measure progress: the cursor's position among all entries. */
export type OutboxFixtureInfo = {
  path: string;
  bytes: number;
  versionstamps: string[];
};
