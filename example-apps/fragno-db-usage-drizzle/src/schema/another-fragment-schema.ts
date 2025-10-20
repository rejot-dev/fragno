// import { pgTable, varchar, text, bigserial, integer, uniqueIndex } from "drizzle-orm/pg-core";
// import { createId } from "@fragno-dev/db/id";

// export const fragno_db_settings = pgTable(
//   "fragno_db_settings",
//   {
//     id: varchar("id", { length: 30 })
//       .notNull()
//       .$defaultFn(() => createId()),
//     key: text("key").notNull(),
//     value: text("value").notNull().default("2"),
//     _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
//     _version: integer("_version").notNull().default(0),
//   },
//   (table) => [uniqueIndex("unique_key").on(table.key)],
// );
