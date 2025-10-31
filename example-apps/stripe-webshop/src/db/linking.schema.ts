// import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
// import { user } from "./auth.schema";

// export const user_stripe_customer = pgTable("user_stripe", {
//   id: text("id").primaryKey(),
//   userId: text("user_id")
//     .notNull()
//     .unique()
//     .references(() => user.id, { onDelete: "cascade" }),
//   customerId: text("customer_id").notNull().unique(),
// });
