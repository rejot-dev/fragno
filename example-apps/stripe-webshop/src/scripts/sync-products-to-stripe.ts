import { config } from "dotenv";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { products } from "@/db/schema";
import { stripeFragment } from "@/lib/stripe";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

// Load environment variables
config({ quiet: true });

/**
 * Sync products from database to Stripe
 * Creates Stripe Products and Prices (monthly/yearly) for each product
 * Updates existing products if they already exist in Stripe
 */
async function syncProductsToStripe() {
  console.log("Starting product sync to Stripe...\n");

  // Create PGlite instance for this script
  const pg = new PGlite(process.env["DATABASE_URL"]!);
  const db = drizzle({ client: pg, schema });

  try {
    // Get Stripe client from fragment
    const stripe = stripeFragment.services.getStripeClient();

    // Fetch all products from database
    const allProducts = await db.select().from(products);

    console.log(`Found ${allProducts.length} products in database\n`);

    for (const product of allProducts) {
      console.log(`Processing: ${product.displayName} (${product.name})`);

      try {
        let stripeProductId = product.stripeProductId;

        // Create or update Stripe Product
        if (stripeProductId) {
          // Update existing product
          console.log(`  → Updating existing Stripe product: ${stripeProductId}`);
          await stripe.products.update(stripeProductId, {
            name: product.displayName,
            description: product.description,
            metadata: {
              dbProductId: product.id,
              dbProductName: product.name,
            },
          });
        } else {
          // Create new product
          console.log(`  → Creating new Stripe product`);
          const stripeProduct = await stripe.products.create({
            name: product.displayName,
            description: product.description,
            metadata: {
              dbProductId: product.id,
              dbProductName: product.name,
            },
          });
          stripeProductId = stripeProduct.id;
          console.log(`  → Created Stripe product: ${stripeProductId}`);
        }

        // Handle monthly price
        let stripeMonthlyPriceId = product.stripeMonthlyPriceId;
        if (product.priceMonthly > 0) {
          if (stripeMonthlyPriceId) {
            // Verify the price still exists and is valid
            try {
              const existingPrice = await stripe.prices.retrieve(stripeMonthlyPriceId);
              if (
                existingPrice.unit_amount !== product.priceMonthly ||
                existingPrice.recurring?.interval !== "month"
              ) {
                // Price changed, create new one (Stripe doesn't allow updating amounts)
                console.log(`  → Monthly price changed, creating new price`);
                const newPrice = await stripe.prices.create({
                  product: stripeProductId,
                  unit_amount: product.priceMonthly,
                  currency: "usd",
                  recurring: { interval: "month" },
                  metadata: {
                    dbProductId: product.id,
                    dbProductName: product.name,
                  },
                });
                stripeMonthlyPriceId = newPrice.id;
                console.log(`  → Created new monthly price: ${stripeMonthlyPriceId}`);
              } else {
                console.log(`  → Monthly price unchanged: ${stripeMonthlyPriceId}`);
              }
            } catch {
              // Price doesn't exist, create new one
              console.log(`  → Monthly price not found, creating new one`);
              const newPrice = await stripe.prices.create({
                product: stripeProductId,
                unit_amount: product.priceMonthly,
                currency: "usd",
                recurring: { interval: "month" },
                metadata: {
                  dbProductId: product.id,
                  dbProductName: product.name,
                },
              });
              stripeMonthlyPriceId = newPrice.id;
              console.log(`  → Created monthly price: ${stripeMonthlyPriceId}`);
            }
          } else {
            // Create new monthly price
            console.log(`  → Creating monthly price`);
            const newPrice = await stripe.prices.create({
              product: stripeProductId,
              unit_amount: product.priceMonthly,
              currency: "usd",
              recurring: { interval: "month" },
              metadata: {
                dbProductId: product.id,
                dbProductName: product.name,
              },
            });
            stripeMonthlyPriceId = newPrice.id;
            console.log(`  → Created monthly price: ${stripeMonthlyPriceId}`);
          }
        }

        // Handle yearly price
        let stripeYearlyPriceId = product.stripeYearlyPriceId;
        if (product.priceYearly > 0) {
          if (stripeYearlyPriceId) {
            // Verify the price still exists and is valid
            try {
              const existingPrice = await stripe.prices.retrieve(stripeYearlyPriceId);
              if (
                existingPrice.unit_amount !== product.priceYearly ||
                existingPrice.recurring?.interval !== "year"
              ) {
                // Price changed, create new one (Stripe doesn't allow updating amounts)
                console.log(`  → Yearly price changed, creating new price`);
                const newPrice = await stripe.prices.create({
                  product: stripeProductId,
                  unit_amount: product.priceYearly,
                  currency: "usd",
                  recurring: { interval: "year" },
                  metadata: {
                    dbProductId: product.id,
                    dbProductName: product.name,
                  },
                });
                stripeYearlyPriceId = newPrice.id;
                console.log(`  → Created new yearly price: ${stripeYearlyPriceId}`);
              } else {
                console.log(`  → Yearly price unchanged: ${stripeYearlyPriceId}`);
              }
            } catch {
              // Price doesn't exist, create new one
              console.log(`  → Yearly price not found, creating new one`);
              const newPrice = await stripe.prices.create({
                product: stripeProductId,
                unit_amount: product.priceYearly,
                currency: "usd",
                recurring: { interval: "year" },
                metadata: {
                  dbProductId: product.id,
                  dbProductName: product.name,
                },
              });
              stripeYearlyPriceId = newPrice.id;
              console.log(`  → Created yearly price: ${stripeYearlyPriceId}`);
            }
          } else {
            // Create new yearly price
            console.log(`  → Creating yearly price`);
            const newPrice = await stripe.prices.create({
              product: stripeProductId,
              unit_amount: product.priceYearly,
              currency: "usd",
              recurring: { interval: "year" },
              metadata: {
                dbProductId: product.id,
                dbProductName: product.name,
              },
            });
            stripeYearlyPriceId = newPrice.id;
            console.log(`  → Created yearly price: ${stripeYearlyPriceId}`);
          }
        }

        // Update database with Stripe IDs
        await db
          .update(products)
          .set({
            stripeProductId,
            stripeMonthlyPriceId,
            stripeYearlyPriceId,
          })
          .where(eq(products.id, product.id));

        console.log(`  ✓ Synced successfully\n`);
      } catch (error) {
        console.error(`  ✗ Error syncing product: ${error}\n`);
      }
    }

    console.log("Product sync completed!");
  } finally {
    // Close PGlite connection
    await pg.close();
  }
}

syncProductsToStripe()
  .catch((error) => {
    console.error("Fatal error during sync:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
