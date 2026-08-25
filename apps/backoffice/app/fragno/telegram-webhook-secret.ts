export function generateTelegramWebhookSecretToken() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `tg_${cryptoApi.randomUUID().replace(/-/g, "")}`;
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `tg_${token}`;
  }
  throw new Error("Secure crypto API unavailable for generating a Telegram secret token.");
}
