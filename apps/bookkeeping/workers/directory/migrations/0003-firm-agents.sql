-- The Backoffice project in each firm that holds its bookkeeping agent, which reviews its clients'
-- documents there, so the firm's own skills never reach a client's workspace.
CREATE TABLE "firm_agent" (
  "firmId" TEXT PRIMARY KEY NOT NULL REFERENCES "organization" ("id"),
  -- The Backoffice project's ID.
  "projectId" TEXT NOT NULL UNIQUE
);
