-- Bookkeeping's read-only copy of the Backoffice organizations it is installed in. Backoffice owns
-- organizations, membership, and roles; rows here record what Backoffice last confirmed. Nothing is
-- deleted when Bookkeeping is uninstalled: its members lose access, and the books stay.
CREATE TABLE "workspace" (
  -- The Backoffice organization's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL
);

CREATE TABLE "workspace_member" (
  "workspaceId" TEXT NOT NULL REFERENCES "workspace" ("id"),
  -- The Backoffice user's ID, which is their account ID in Bookkeeping's auth.
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  -- Backoffice roles, comma-separated: owner, admin, member.
  "roles" TEXT NOT NULL,
  -- When Backoffice last confirmed this membership, in epoch milliseconds.
  "confirmedAt" INTEGER NOT NULL,
  PRIMARY KEY ("workspaceId", "userId")
);

CREATE INDEX "workspace_member_user" ON "workspace_member" ("userId");

-- Invitations Bookkeeping created in Backoffice, kept to show the invitation page before the
-- invited person signs in.
CREATE TABLE "workspace_invitation" (
  -- The Backoffice invitation's ID.
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "workspace" ("id"),
  "email" TEXT NOT NULL,
  "roles" TEXT NOT NULL,
  "invitedBy" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL
);

CREATE INDEX "workspace_invitation_workspace" ON "workspace_invitation" ("workspaceId");
