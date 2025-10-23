import { config } from "dotenv";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "./schema";

// Load environment variables
config({ quiet: true });

async function seed() {
  console.log("Seeding users...");

  // Create PGlite instance for this script
  const pg = new PGlite(process.env["DATABASE_URL"]!);
  const db = drizzle({ client: pg, schema });

  // Create auth instance with local db
  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
    }),
    emailAndPassword: {
      enabled: true,
    },
    secret: process.env["BETTER_AUTH_SECRET"]!,
    baseURL: process.env["BETTER_AUTH_URL"]!,
  });

  try {
    await auth.api.signUpEmail({
      body: {
        name: "Bert van Putten",
        email: "user@example.com",
        password: "password123",
      },
    });
    console.log("✓ User seeded successfully!");
  } finally {
    // Close PGlite connection
    await pg.close();
  }
}

seed()
  .catch((error) => {
    console.error("Error seeding products:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
