import { config } from "dotenv";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { products } from "./schema";
import * as schema from "./schema";

// Load environment variables
config({ quiet: true });

const productsData = [
  {
    id: "free",
    name: "free",
    displayName: "Free",
    description: "Perfect for trying out our platform with basic features",
    priceMonthly: 0,
    priceYearly: 0,
  },
  {
    id: "plus",
    name: "plus",
    displayName: "Plus",
    description: "Enhanced features for growing teams and professionals",
    priceMonthly: 900, // $9.00
    priceYearly: 9000, // $90.00
  },
  {
    id: "premium",
    name: "premium",
    displayName: "Premium",
    description: "Full access to all features for power users and enterprises",
    priceMonthly: 2900, // $29.00
    priceYearly: 29000, // $290.00
  },
];

async function seed() {
  console.log("Seeding products...");

  // Create PGlite instance for this script
  const pg = new PGlite(process.env["DATABASE_URL"]!);
  const db = drizzle({ client: pg, schema });

  try {
    for (const product of productsData) {
      await db.insert(products).values(product).onConflictDoNothing({ target: products.name });
    }

    console.log("✓ Products seeded successfully!");
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
