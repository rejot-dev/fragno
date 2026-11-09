-- Bookkeeping's agents come from packages it publishes in its Marketplace in Backoffice and installs
-- in each project it prompts them in, so it no longer records the definitions it wrote.
ALTER TABLE "firm_agent"
DROP COLUMN "definition";

ALTER TABLE "administration"
DROP COLUMN "agentDefinition";

-- Where the agent package stands in each agent project: the firm's agent project, or an
-- administration's. A project without a row has none installed yet.
CREATE TABLE "agent_package" (
  -- The Backoffice project's ID.
  "projectId" TEXT PRIMARY KEY NOT NULL,
  -- The version Backoffice last said is installed; null before, or once the agent went missing.
  "installedVersion" TEXT,
  -- The install Bookkeeping asked for and has not seen finish: its version, and Backoffice's run,
  -- null until Bookkeeping hears Backoffice's answer to starting it. Bookkeeping records an install
  -- before it asks for it, so one whose answer never arrived is still followed.
  "installingVersion" TEXT,
  "workflowInstanceId" TEXT,
  -- Steps in a row that Backoffice refused or failed, which space out the next.
  "failures" INTEGER NOT NULL DEFAULT 0,
  -- When the next step is due, in milliseconds since the epoch.
  "nextStepAt" INTEGER NOT NULL DEFAULT 0,
  CHECK (
    "workflowInstanceId" IS NULL
    OR "installingVersion" IS NOT NULL
  )
);
