-- Operators become an organization: the one whose members run Bookkeeping. SQLite cannot change a
-- CHECK constraint in place, so the tables are rebuilt with their rows. The tables that reference
-- organizations are set aside first, and the new organization table references itself until it
-- is renamed, so no foreign key ever points at a missing organization.
CREATE TABLE "membership_kept" AS
SELECT
  *
FROM
  "membership";

CREATE TABLE "invitation_kept" AS
SELECT
  *
FROM
  "invitation";

CREATE TABLE "administration_kept" AS
SELECT
  *
FROM
  "administration";

DROP TABLE "membership";

DROP TABLE "invitation";

DROP TABLE "administration";

CREATE TABLE "organization_next" (
  -- The Backoffice organization's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  -- Operators run Bookkeeping; a firm keeps the books of its clients; a client is one business
  -- whose books it keeps.
  "kind" TEXT NOT NULL CHECK ("kind" IN ('operator', 'firm', 'client')),
  -- The firm that created a client; operators and firms have none.
  "firmId" TEXT REFERENCES "organization_next" ("id"),
  CHECK (("kind" = 'client') = ("firmId" IS NOT NULL))
);

-- Firms before their clients, whose firm must exist.
INSERT INTO
  "organization_next" ("id", "slug", "name", "kind", "firmId")
SELECT
  "id",
  "slug",
  "name",
  "kind",
  "firmId"
FROM
  "organization"
ORDER BY
  "kind" = 'client';

DROP TABLE "organization";

ALTER TABLE "organization_next"
RENAME TO "organization";

CREATE INDEX "organization_firm" ON "organization" ("firmId");

CREATE TABLE "membership" (
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id"),
  -- The Backoffice user's ID.
  "userId" TEXT NOT NULL,
  -- Backoffice roles as a JSON array: owner, admin, member.
  "roles" TEXT NOT NULL,
  -- When Backoffice last confirmed this membership, in epoch milliseconds.
  "confirmedAt" INTEGER NOT NULL,
  PRIMARY KEY ("organizationId", "userId")
);

INSERT INTO
  "membership"
SELECT
  *
FROM
  "membership_kept";

DROP TABLE "membership_kept";

CREATE INDEX "membership_user" ON "membership" ("userId");

CREATE TABLE "invitation" (
  -- The Backoffice invitation's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id"),
  "email" TEXT NOT NULL,
  -- Backoffice roles as a JSON array: owner, admin, member.
  "roles" TEXT NOT NULL,
  -- The inviting person's name, as they gave it to Bookkeeping.
  "invitedBy" TEXT NOT NULL,
  -- When Backoffice stops accepting it, in epoch milliseconds.
  "expiresAt" INTEGER NOT NULL
);

INSERT INTO
  "invitation"
SELECT
  *
FROM
  "invitation_kept";

DROP TABLE "invitation_kept";

CREATE INDEX "invitation_organization" ON "invitation" ("organizationId");

CREATE TABLE "administration" (
  -- The Backoffice project's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "organization" ("id"),
  -- The Backoffice project's slug, unique in its organization.
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  UNIQUE ("clientId", "slug")
);

INSERT INTO
  "administration"
SELECT
  *
FROM
  "administration_kept";

DROP TABLE "administration_kept";
