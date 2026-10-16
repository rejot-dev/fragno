-- Backoffice installs apps for an organization or a user, so a link names its Backoffice owner by
-- scope segment, e.g. `org:<id>` or `user:<id>`. Backoffice IDs are alphanumeric, so prefixing an
-- organization ID yields its segment.
ALTER TABLE "backoffice_link"
RENAME COLUMN "backofficeOrganizationId" TO "backofficeOwner";

UPDATE "backoffice_link"
SET
  "backofficeOwner" = 'org:' || "backofficeOwner";

-- Backoffice renamed the resource scope that approves everything its owner has.
UPDATE "backoffice_link"
SET
  "resourceScope" = '{"kind":"owner"}'
WHERE
  "resourceScope" = '{"kind":"organization"}';
