-- A workspace's administrations, each the books of one business. Bookkeeping creates them; each is
-- a Backoffice project in the workspace's organization, and its books are in the `Books` object
-- named by the project's ID.
CREATE TABLE "administration" (
  -- The Backoffice project's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "workspace" ("id"),
  -- The Backoffice project's slug, unique in its organization.
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  UNIQUE ("workspaceId", "slug")
);
