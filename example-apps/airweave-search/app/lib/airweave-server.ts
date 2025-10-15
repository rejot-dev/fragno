import { createAirweaveFragment } from "@fragno-dev/airweave-fragment";

if (!process.env.AIRWEAVE_API_KEY) {
  throw new Error("AIRWEAVE_API_KEY environment variable is required");
}

export const airweaveFragment = createAirweaveFragment({
  apiKey: process.env.AIRWEAVE_API_KEY,
  baseUrl: process.env.AIRWEAVE_BASE_URL,
}) as ReturnType<typeof createAirweaveFragment>;
