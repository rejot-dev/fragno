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
CREATE TABLE `subscriber_mailing_list` (
  `id` text NOT NULL,
  `email` text NOT NULL,
  `subscribedAt` integer DEFAULT (
    cast(
      (julianday('now') - 2440587.5) * 86400000 AS integer
    )
  ) NOT NULL,
  `_internalId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `_version` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE INDEX `idx_subscriber_email_mailing-list` ON `subscriber_mailing_list` (`email`);

--> statement-breakpoint
CREATE INDEX `idx_subscriber_subscribedAt_mailing-list` ON `subscriber_mailing_list` (`subscribedAt`);
