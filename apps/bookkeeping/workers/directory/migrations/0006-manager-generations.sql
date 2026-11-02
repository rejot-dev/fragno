-- How many times Bookkeeping recorded a change of the client's firm. Each request to a firm's
-- agent records the generation it was asked under, so withdrawing a former firm's requests leaves
-- those asked of the firm managing the client now.
ALTER TABLE "organization"
ADD COLUMN "managerGeneration" INTEGER NOT NULL DEFAULT 0;

-- Requests recorded before generations have generation 0, so a withdrawal still pending withdraws
-- them.
UPDATE "organization"
SET
  "managerGeneration" = 1
WHERE
  "withdrawalPending" = 1;
