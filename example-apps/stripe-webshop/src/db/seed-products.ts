import { db } from "./index";
import { products } from "./schema";

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

  for (const product of productsData) {
    await db.insert(products).values(product).onConflictDoNothing({ target: products.name });
  }

  console.log("✓ Products seeded successfully!");
}

seed()
  .catch((error) => {
    console.error("Error seeding products:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
