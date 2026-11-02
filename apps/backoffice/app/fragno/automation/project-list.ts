/** A workspace's projects that are not archived, as the project menu and the universe list them. */
export type AutomationProjectList =
  | { kind: "listed"; projects: { id: string; slug: string; name: string }[] }
  | { kind: "failed"; message: string };
