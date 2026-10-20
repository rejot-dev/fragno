-- Better Auth 1.7.1 organization plugin (without teams or dynamic roles).
CREATE TABLE "organization" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "createdAt" date NOT NULL,
  "metadata" text
);

CREATE TABLE "member" (
  "id" text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "createdAt" date NOT NULL
);

CREATE TABLE "invitation" (
  "id" text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "inviterId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

ALTER TABLE "session"
ADD COLUMN "activeOrganizationId" text;

CREATE INDEX "organization_slug_idx" ON "organization" ("slug");

CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");

CREATE INDEX "member_userId_idx" ON "member" ("userId");

CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");

CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

-- A pending "Connect to Backoffice" started by an organization owner or admin. The state is
-- single-use and bound to the user who started it, so a callback cannot be replayed or hijacked.
CREATE TABLE "backoffice_link_request" (
  "state" text NOT NULL PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "expiresAt" integer NOT NULL
);

-- One Bookkeeping organization links to one Backoffice organization, and vice versa.
CREATE TABLE "backoffice_link" (
  "organizationId" text NOT NULL PRIMARY KEY REFERENCES "organization" ("id") ON DELETE CASCADE,
  "backofficeOrganizationId" text NOT NULL UNIQUE,
  "resourceScope" text NOT NULL,
  "linkedByUserId" text NOT NULL,
  "linkedAt" integer NOT NULL
);
