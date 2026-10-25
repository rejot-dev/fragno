/** A workspace's projects that are not archived, by slug, as the project menu lists them. */
export type AutomationProjectList =
  | { kind: "listed"; projects: { slug: string; name: string }[] }
  | { kind: "failed"; message: string };
