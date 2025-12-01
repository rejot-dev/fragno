export type TurnstileResult = {
  success: boolean;
  "error-codes": string[];
};

export async function validateTurnstileToken(
  secretKey: string | undefined,
  token: string,
): Promise<TurnstileResult> {
  try {
    if (!secretKey) {
      console.warn("Turnstile secret key not set, skipping validation.");
      return { success: true, "error-codes": [] };
    }

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
      }),
    });

    const result = await response.json();
    return result as TurnstileResult;
  } catch (error) {
    console.error("Turnstile validation error:", error);
    return { success: false, "error-codes": ["internal-error"] };
  }
}
