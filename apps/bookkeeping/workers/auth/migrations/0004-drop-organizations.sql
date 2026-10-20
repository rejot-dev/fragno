-- Workspaces are Backoffice organizations now, copied into the Workspaces object; Bookkeeping's own
-- organizations and their links to Backoffice are gone.
DROP TABLE "backoffice_link_request";

DROP TABLE "backoffice_link";

DROP TABLE "invitation";

DROP TABLE "member";

DROP TABLE "organization";

ALTER TABLE "session"
DROP COLUMN "activeOrganizationId";
