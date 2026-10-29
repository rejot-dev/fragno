-- A client's firm is the one Backoffice says manages it, which a Backoffice administrator may
-- change or end: a client may have no firm, and a change withdraws what the former firm was asked.
-- SQLite cannot change a CHECK constraint in place, so the tables are rebuilt with their rows, as
-- 0002 did: the tables that reference organizations are set aside first, and the new organization
-- table references itself until it is renamed.
CREATE TABLE "membership_kept" AS
SELECT
  "organizationId",
  "userId",
  "roles",
  "confirmedAt",
  "through"
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

CREATE TABLE "firm_agent_kept" AS
SELECT
  *
FROM
  "firm_agent";

DROP TABLE "membership";

DROP TABLE "invitation";

DROP TABLE "administration";

DROP TABLE "firm_agent";

CREATE TABLE "organization_next" (
  -- The Backoffice organization's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  -- Operators run Bookkeeping; a firm keeps the books of its clients; a client is one business
  -- whose books it keeps.
  "kind" TEXT NOT NULL CHECK ("kind" IN ('operator', 'firm', 'client')),
  -- The firm managing a client, as Backoffice last said; none when no firm Bookkeeping knows
  -- manages it. Operators and firms have none.
  "firmId" TEXT REFERENCES "organization_next" ("id"),
  -- 1 while the requests a client's former firm was asked still have to be withdrawn: set with
  -- the new firm, cleared once they are, so a failure in between is retried.
  "withdrawalPending" INTEGER NOT NULL DEFAULT 0 CHECK ("withdrawalPending" IN (0, 1)),
  CHECK (
    "kind" = 'client'
    OR "firmId" IS NULL
  ),
  CHECK (
    "kind" = 'client'
    OR "withdrawalPending" = 0
  )
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
  -- How the person reaches the organization: as one of its members, or as a member of the firm
  -- that manages it.
  "through" TEXT NOT NULL CHECK ("through" IN ('membership', 'firm')),
  PRIMARY KEY ("organizationId", "userId")
);

INSERT INTO
  "membership" (
    "organizationId",
    "userId",
    "roles",
    "confirmedAt",
    "through"
  )
SELECT
  "organizationId",
  "userId",
  "roles",
  "confirmedAt",
  "through"
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
  "invitation" (
    "id",
    "organizationId",
    "email",
    "roles",
    "invitedBy",
    "expiresAt"
  )
SELECT
  "id",
  "organizationId",
  "email",
  "roles",
  "invitedBy",
  "expiresAt"
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
  "administration" ("id", "clientId", "slug", "name")
SELECT
  "id",
  "clientId",
  "slug",
  "name"
FROM
  "administration_kept";

DROP TABLE "administration_kept";

CREATE TABLE "firm_agent" (
  "firmId" TEXT PRIMARY KEY NOT NULL REFERENCES "organization" ("id"),
  -- The Backoffice project's ID.
  "projectId" TEXT NOT NULL UNIQUE
);

INSERT INTO
  "firm_agent" ("firmId", "projectId")
SELECT
  "firmId",
  "projectId"
FROM
  "firm_agent_kept";

DROP TABLE "firm_agent_kept";
