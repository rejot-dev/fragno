PRAGMA foreign_keys = OFF;

--> statement-breakpoint
CREATE TABLE `__new_form_forms` (
  `id` text NOT NULL,
  `title` text NOT NULL,
  `description` text,
  `slug` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `dataSchema` blob NOT NULL,
  `uiSchema` blob,
  `version` integer DEFAULT 1 NOT NULL,
  `createdAt` integer DEFAULT (
    cast(
      (julianday('now') - 2440587.5) * 86400000 AS integer
    )
  ) NOT NULL,
  `updatedAt` integer DEFAULT (
    cast(
      (julianday('now') - 2440587.5) * 86400000 AS integer
    )
  ) NOT NULL,
  `_internalId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `_version` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
INSERT INTO
  `__new_form_forms` (
    "id",
    "title",
    "description",
    "slug",
    "status",
    "dataSchema",
    "uiSchema",
    "version",
    "createdAt",
    "updatedAt",
    "_internalId",
    "_version"
  )
SELECT
  "id",
  "title",
  "description",
  "slug",
  "status",
  "dataSchema",
  "uiSchema",
  "version",
  "createdAt",
  "updatedAt",
  "_internalId",
  "_version"
FROM
  `form_forms`;

--> statement-breakpoint
DROP TABLE `form_forms`;

--> statement-breakpoint
ALTER TABLE `__new_form_forms`
RENAME TO `form_forms`;

--> statement-breakpoint
PRAGMA foreign_keys = ON;

--> statement-breakpoint
CREATE INDEX `idx_form_status_forms` ON `form_forms` (`status`);

--> statement-breakpoint
CREATE UNIQUE INDEX `idx_form_slug_forms` ON `form_forms` (`slug`);
