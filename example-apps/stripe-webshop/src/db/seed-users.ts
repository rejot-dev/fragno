import { config } from "dotenv";
import { auth } from "@/lib/auth/auth";
import { db } from "@/db";
import { user } from "@/db/schema";
import { eq } from "drizzle-orm";

// Load environment variables
config({ quiet: true });

const defaultUser = {
  name: "Bert van Putten",
  email: "user@example.com",
  password: "password123",
};

async function seed() {
  console.log("Seeding users...");

  try {
    const { user } = await auth.api.signUpEmail({
      body: defaultUser,
    });
    console.log("✓ User seeded successfully! ", user.id);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
      console.log("✓ User was already created");
    } else {
      throw error;
    }
  }

  // make admin
  await db.update(user).set({ role: "admin" }).where(eq(user.email, defaultUser.email));
  console.log("User made admin");
}

await seed();
