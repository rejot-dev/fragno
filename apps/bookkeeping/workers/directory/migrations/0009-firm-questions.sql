-- Questions an administration's agent asks the firm keeping its books, when the books cannot answer
-- them. The firm keeping the client's books now reads them on its dashboard, and answers them into
-- the administration's conversation. The first answer is kept before it is delivered, so delivering
-- it again after a failure sends the same answer, whoever retries.
CREATE TABLE "firm_question" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "administrationId" TEXT NOT NULL REFERENCES "administration" ("id"),
  "question" TEXT NOT NULL,
  "askedAt" INTEGER NOT NULL,
  -- All three null while the question waits for the firm.
  "answer" TEXT,
  "answeredBy" TEXT,
  "answeredAt" INTEGER,
  -- Null until the answer reached the administration's conversation.
  "deliveredAt" INTEGER,
  CHECK (
    ("answer" IS NULL) = ("answeredBy" IS NULL)
    AND ("answer" IS NULL) = ("answeredAt" IS NULL)
  ),
  CHECK (
    "deliveredAt" IS NULL
    OR "answer" IS NOT NULL
  )
);

CREATE INDEX "firm_question_waiting" ON "firm_question" ("administrationId", "askedAt")
WHERE
  "deliveredAt" IS NULL;
