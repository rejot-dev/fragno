-- The Backoffice organizations Bookkeeping knows, and what Backoffice last confirmed about who
-- belongs to them. Backoffice owns organizations, membership, and roles. Nothing here is deleted
-- when someone loses access: their membership row goes, and the organization and its books stay.
CREATE TABLE "organization" (
  -- The Backoffice organization's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  -- A firm keeps the books of its clients; a client is one business whose books it keeps.
  "kind" TEXT NOT NULL CHECK ("kind" IN ('firm', 'client')),
  -- The firm that created a client; firms have none.
  "firmId" TEXT REFERENCES "organization" ("id"),
  CHECK (("kind" = 'firm') = ("firmId" IS NULL))
);

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

CREATE INDEX "membership_user" ON "membership" ("userId");

-- Invitations Bookkeeping created in Backoffice, kept to show the invitation page before the
-- invited person signs in. Backoffice decides whether one can still be accepted; a row goes once
-- it is accepted or Backoffice no longer offers it.
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

CREATE INDEX "invitation_organization" ON "invitation" ("organizationId");

-- A client's administrations, each the books of one business. Each is a Backoffice project in the
-- client's organization, and its books are in the `Books` object named by the project's ID.
CREATE TABLE "administration" (
  -- The Backoffice project's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "organization" ("id"),
  -- The Backoffice project's slug, unique in its organization.
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  UNIQUE ("clientId", "slug")
);
