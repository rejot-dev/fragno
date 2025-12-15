CREATE TABLE `form_forms` (
  `id` text NOT NULL,
  `title` text NOT NULL,
  `description` text,
  `slug` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `dataSchema` blob NOT NULL,
  `uiSchema` blob NOT NULL,
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
CREATE INDEX `idx_form_status_forms` ON `form_forms` (`status`);

--> statement-breakpoint
CREATE UNIQUE INDEX `idx_form_slug_forms` ON `form_forms` (`slug`);

--> statement-breakpoint
CREATE TABLE `fragno_db_settings` (
  `id` text NOT NULL,
  `key` text NOT NULL,
  `value` text NOT NULL,
  `_internalId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `_version` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `unique_key` ON `fragno_db_settings` (`key`);

--> statement-breakpoint
CREATE TABLE `fragno_hooks` (
  `id` text NOT NULL,
  `namespace` text NOT NULL,
  `hookName` text NOT NULL,
  `payload` blob NOT NULL,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `maxAttempts` integer DEFAULT 5 NOT NULL,
  `lastAttemptAt` integer,
  `nextRetryAt` integer,
  `error` text,
  `createdAt` integer DEFAULT (
    cast(
      (julianday('now') - 2440587.5) * 86400000 AS integer
    )
  ) NOT NULL,
  `nonce` text NOT NULL,
  `_internalId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `_version` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE INDEX `idx_namespace_status_retry` ON `fragno_hooks` (`namespace`, `status`, `nextRetryAt`);

--> statement-breakpoint
CREATE INDEX `idx_nonce` ON `fragno_hooks` (`nonce`);

--> statement-breakpoint
CREATE TABLE `response_forms` (
  `id` text NOT NULL,
  `formId` text NOT NULL,
  `formVersion` integer NOT NULL,
  `data` blob NOT NULL,
  `submittedAt` integer DEFAULT (
    cast(
      (julianday('now') - 2440587.5) * 86400000 AS integer
    )
  ) NOT NULL,
  `userAgent` text,
  `ip` text,
  `_internalId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `_version` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE INDEX `idx_response_form_forms` ON `response_forms` (`formId`);

--> statement-breakpoint
CREATE INDEX `idx_response_submitted_at_forms` ON `response_forms` (`submittedAt`);
