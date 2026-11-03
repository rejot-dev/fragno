-- The firm's bookkeeping agent's definition as Bookkeeping last wrote it, which Backoffice stored:
-- its description, model, permissions, and instructions, as JSON. Bookkeeping updates the agent to
-- its current definition only while Backoffice still stores this one, so a definition the firm's
-- members changed is theirs to keep. Null for agents set up before Bookkeeping recorded it, which
-- Bookkeeping takes as its own.
ALTER TABLE "firm_agent"
ADD COLUMN "definition" TEXT;
