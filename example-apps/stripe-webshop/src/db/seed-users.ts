import { auth } from "@/lib/auth/auth";

async function seed() {
  console.log("Seeding users...");

  await auth.api.signUpEmail({
    body: {
      name: "Bert van Putten",
      email: "user@example.com",
      password: "password123",
    },
  });
  console.log("done?");
}

seed()
  .catch((error) => {
    console.error("Error seeding products:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
