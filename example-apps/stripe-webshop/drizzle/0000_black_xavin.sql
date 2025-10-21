CREATE TABLE `todos` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch())
);
