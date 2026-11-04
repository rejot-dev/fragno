-- The definition of the agent in each administration's project that answers questions about its
-- books, as Bookkeeping last wrote it, which Backoffice stored: its description, model, permissions,
-- and instructions, as JSON. As for the firm's bookkeeping agent, Bookkeeping updates the agent to
-- its current definition only while Backoffice still stores this one, so a definition the client's
-- members changed is theirs to keep. Null until Bookkeeping first defines the agent.
ALTER TABLE "administration"
ADD COLUMN "agentDefinition" TEXT;
