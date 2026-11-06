// Runs the Pulumi CLI with the S3 keys for the state bucket derived from CLOUDFLARE_API_TOKEN, so
// that token is the only Cloudflare credential anyone has to store. R2's S3 API takes the token's
// ID as the Access Key ID and the SHA-256 of its value as the Secret Access Key.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ACCOUNT_ID = "cda934461b3c3f24b4899fc8a100ffe6";

async function verifyTokenId(token: string, path: string): Promise<string | undefined> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}/tokens/verify`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const envelope = (await response.json()) as { success: boolean; result: { id: string } };
  return envelope.success ? envelope.result.id : undefined;
}

const token = process.env["CLOUDFLARE_API_TOKEN"];
if (!token) {
  throw new Error("Set CLOUDFLARE_API_TOKEN, see apps/infra/README.md.");
}

// Account-owned and user-owned tokens are verified at different endpoints.
const tokenId =
  (await verifyTokenId(token, `accounts/${ACCOUNT_ID}`)) ?? (await verifyTokenId(token, "user"));
if (!tokenId) {
  throw new Error("CLOUDFLARE_API_TOKEN is not a valid token for the ReJot account.");
}

const result = spawnSync("pulumi", process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    AWS_ACCESS_KEY_ID: tokenId,
    AWS_SECRET_ACCESS_KEY: createHash("sha256").update(token).digest("hex"),
  },
});
process.exit(result.status ?? 1);
