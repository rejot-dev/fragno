import { config } from "dotenv";
import { PLANS } from "@/lib/plans";
import { stripeFragment } from "@/lib/stripe";

// Load environment variables
config({ quiet: true });

/**
 * Sync plans from in-code constant to Stripe
 * Creates Stripe Products and Prices (monthly/yearly) for each plan
 * Updates existing products if they already exist in Stripe
 *
 * NOTE: After running this script, you need to update the Stripe IDs in @/lib/plans.ts manually
 */
async function syncProductsToStripe() {
  console.log("Starting plan sync to Stripe...\n");

  try {
    // Get Stripe client from fragment
    const stripe = stripeFragment.services.getStripeClient();

    console.log(`Found ${PLANS.length} plans to sync\n`);

    for (const plan of PLANS) {
      console.log(`Processing: ${plan.displayName} (${plan.name})`);

      try {
        let stripeProductId = plan.stripeProductId;

        // Create or update Stripe Product
        if (stripeProductId) {
          // Update existing product
          console.log(`  → Updating existing Stripe product: ${stripeProductId}`);
          await stripe.products.update(stripeProductId, {
            name: plan.displayName,
            description: plan.description,
            metadata: {
              planId: plan.id,
              planName: plan.name,
            },
          });
        } else {
          // Create new product
          console.log(`  → Creating new Stripe product`);
          const stripeProduct = await stripe.products.create({
            name: plan.displayName,
            description: plan.description,
            metadata: {
              planId: plan.id,
              planName: plan.name,
            },
          });
          stripeProductId = stripeProduct.id;
          console.log(`  → Created Stripe product: ${stripeProductId}`);
          console.log(
            `  → IMPORTANT: Add this to @/lib/plans.ts: stripeProductId: "${stripeProductId}"`,
          );
        }

        // Handle monthly price
        let stripeMonthlyPriceId = plan.stripeMonthlyPriceId;
        if (plan.priceMonthly > 0) {
          if (stripeMonthlyPriceId) {
            // Verify the price still exists and is valid
            try {
              const existingPrice = await stripe.prices.retrieve(stripeMonthlyPriceId);
              if (
                existingPrice.unit_amount !== plan.priceMonthly ||
                existingPrice.recurring?.interval !== "month"
              ) {
                // Price changed, create new one (Stripe doesn't allow updating amounts)
                console.log(`  → Monthly price changed, creating new price`);
                const newPrice = await stripe.prices.create({
                  product: stripeProductId,
                  unit_amount: plan.priceMonthly,
                  currency: "usd",
                  recurring: { interval: "month" },
                  metadata: {
                    planId: plan.id,
                    planName: plan.name,
                  },
                });
                stripeMonthlyPriceId = newPrice.id;
                console.log(`  → Created new monthly price: ${stripeMonthlyPriceId}`);
                console.log(
                  `  → IMPORTANT: Add this to @/lib/plans.ts: stripeMonthlyPriceId: "${stripeMonthlyPriceId}"`,
                );
              } else {
                console.log(`  → Monthly price unchanged: ${stripeMonthlyPriceId}`);
              }
            } catch {
              // Price doesn't exist, create new one
              console.log(`  → Monthly price not found, creating new one`);
              const newPrice = await stripe.prices.create({
                product: stripeProductId,
                unit_amount: plan.priceMonthly,
                currency: "usd",
                recurring: { interval: "month" },
                metadata: {
                  planId: plan.id,
                  planName: plan.name,
                },
              });
              stripeMonthlyPriceId = newPrice.id;
              console.log(`  → Created monthly price: ${stripeMonthlyPriceId}`);
              console.log(
                `  → IMPORTANT: Add this to @/lib/plans.ts: stripeMonthlyPriceId: "${stripeMonthlyPriceId}"`,
              );
            }
          } else {
            // Create new monthly price
            console.log(`  → Creating monthly price`);
            const newPrice = await stripe.prices.create({
              product: stripeProductId,
              unit_amount: plan.priceMonthly,
              currency: "usd",
              recurring: { interval: "month" },
              metadata: {
                planId: plan.id,
                planName: plan.name,
              },
            });
            stripeMonthlyPriceId = newPrice.id;
            console.log(`  → Created monthly price: ${stripeMonthlyPriceId}`);
            console.log(
              `  → IMPORTANT: Add this to @/lib/plans.ts: stripeMonthlyPriceId: "${stripeMonthlyPriceId}"`,
            );
          }
        }

        // Handle yearly price
        let stripeYearlyPriceId = plan.stripeYearlyPriceId;
        if (plan.priceYearly > 0) {
          if (stripeYearlyPriceId) {
            // Verify the price still exists and is valid
            try {
              const existingPrice = await stripe.prices.retrieve(stripeYearlyPriceId);
              if (
                existingPrice.unit_amount !== plan.priceYearly ||
                existingPrice.recurring?.interval !== "year"
              ) {
                // Price changed, create new one (Stripe doesn't allow updating amounts)
                console.log(`  → Yearly price changed, creating new price`);
                const newPrice = await stripe.prices.create({
                  product: stripeProductId,
                  unit_amount: plan.priceYearly,
                  currency: "usd",
                  recurring: { interval: "year" },
                  metadata: {
                    planId: plan.id,
                    planName: plan.name,
                  },
                });
                stripeYearlyPriceId = newPrice.id;
                console.log(`  → Created new yearly price: ${stripeYearlyPriceId}`);
                console.log(
                  `  → IMPORTANT: Add this to @/lib/plans.ts: stripeYearlyPriceId: "${stripeYearlyPriceId}"`,
                );
              } else {
                console.log(`  → Yearly price unchanged: ${stripeYearlyPriceId}`);
              }
            } catch {
              // Price doesn't exist, create new one
              console.log(`  → Yearly price not found, creating new one`);
              const newPrice = await stripe.prices.create({
                product: stripeProductId,
                unit_amount: plan.priceYearly,
                currency: "usd",
                recurring: { interval: "year" },
                metadata: {
                  planId: plan.id,
                  planName: plan.name,
                },
              });
              stripeYearlyPriceId = newPrice.id;
              console.log(`  → Created yearly price: ${stripeYearlyPriceId}`);
              console.log(
                `  → IMPORTANT: Add this to @/lib/plans.ts: stripeYearlyPriceId: "${stripeYearlyPriceId}"`,
              );
            }
          } else {
            // Create new yearly price
            console.log(`  → Creating yearly price`);
            const newPrice = await stripe.prices.create({
              product: stripeProductId,
              unit_amount: plan.priceYearly,
              currency: "usd",
              recurring: { interval: "year" },
              metadata: {
                planId: plan.id,
                planName: plan.name,
              },
            });
            stripeYearlyPriceId = newPrice.id;
            console.log(`  → Created yearly price: ${stripeYearlyPriceId}`);
            console.log(
              `  → IMPORTANT: Add this to @/lib/plans.ts: stripeYearlyPriceId: "${stripeYearlyPriceId}"`,
            );
          }
        }

        console.log(`  ✓ Synced successfully\n`);
      } catch (error) {
        console.error(`  ✗ Error syncing product: ${error}\n`);
      }
    }

    console.log("\nPlan sync completed!");
    console.log("\nREMINDER: Copy the Stripe IDs from the output above and update @/lib/plans.ts");
  } catch (error) {
    console.error("Fatal error during sync:", error);
    throw error;
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
